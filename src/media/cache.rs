//! Calendar-week buckets avoid per-file timestamps, size totals, and LRU bookkeeping.
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use time::{Date, OffsetDateTime, Weekday};

fn week_name(date: Date) -> String {
    let (year, week, _) = date.to_iso_week_date();
    format!("{year:04}-W{week:02}")
}

pub fn folders(data: &Path, date: Date) -> [PathBuf; 2] {
    let root = data.join("thumbnails");
    [
        root.join(week_name(date)),
        root.join(week_name(date - time::Duration::weeks(1))),
    ]
}

fn is_week_name(name: &str) -> bool {
    let Some((year, week)) = name.split_once("-W") else {
        return false;
    };
    if year.len() != 4 || week.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(week)) = (year.parse::<i32>(), week.parse::<u8>()) else {
        return false;
    };
    Date::from_iso_week_date(year, week, Weekday::Monday).is_ok_and(|date| week_name(date) == name)
}

fn clean(data: &Path, date: Date) -> io::Result<()> {
    let entries = match fs::read_dir(data.join("thumbnails")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let oldest = week_name(date - time::Duration::weeks(1));
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // Old flat caches and unrelated directories are deliberately ignored.
        if is_week_name(name) && name < oldest.as_str() && entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

// Start once with the service. Only a changed UTC week triggers directory I/O;
// deletion runs outside both HTTP threads and the media worker pool.
pub async fn maintain(data: PathBuf) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    let mut last_week = String::new();
    loop {
        interval.tick().await;
        let date = OffsetDateTime::now_utc().date();
        let week = week_name(date);
        if week == last_week {
            continue;
        }
        last_week = week;
        let data = data.clone();
        match tokio::task::spawn_blocking(move || clean(&data, date)).await {
            Ok(Ok(())) => {}
            result => tracing::warn!(?result, "Could not clean weekly media cache"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Month;

    #[test]
    fn bucket_names_follow_iso_weeks_across_year_boundary() {
        let date = Date::from_calendar_date(2021, Month::January, 4).unwrap();
        assert_eq!(
            folders(Path::new("data"), date),
            [
                Path::new("data/thumbnails/2021-W01").to_path_buf(),
                Path::new("data/thumbnails/2020-W53").to_path_buf(),
            ]
        );
    }

    #[test]
    fn cleanup_keeps_two_weeks_and_leaves_legacy_data_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("thumbnails");
        for name in [
            "2020-W52",
            "2020-W53",
            "2021-W01",
            "2021-W02",
            "unrelated",
            "2020-W99",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("cache.jpg"), b"cached").unwrap();
        }
        fs::write(root.join("legacy.jpg"), b"old flat cache").unwrap();
        clean(
            dir.path(),
            Date::from_calendar_date(2021, Month::January, 4).unwrap(),
        )
        .unwrap();
        assert!(!root.join("2020-W52").exists());
        for name in [
            "2020-W53",
            "2021-W01",
            "2021-W02",
            "unrelated",
            "2020-W99",
            "legacy.jpg",
        ] {
            assert!(root.join(name).exists(), "{name}");
        }
    }
}
