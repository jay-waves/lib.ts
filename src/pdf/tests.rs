use super::*;
#[test]
fn leases_keep_all_active_pdfs_resident_until_release() {
    let root = tempfile::tempdir().unwrap();
    let renderer = NativePdfRenderer::default();
    let paths = (0..5)
        .map(|index| root.path().join(format!("{index}.pdf")))
        .collect::<Vec<_>>();
    renderer.set_active_paths(paths.clone());
    let snapshots = paths
        .iter()
        .map(|path| {
            std::fs::write(path, pdf_with_nested_outline()).unwrap();
            let (snapshot, _) = renderer.snapshot(path, &revision(path).unwrap()).unwrap();
            Arc::downgrade(&snapshot)
        })
        .collect::<Vec<_>>();
    renderer.evict_idle(Duration::ZERO);
    assert!(
        snapshots
            .iter()
            .all(|snapshot| snapshot.upgrade().is_some())
    );
    renderer.set_active_paths([]);
    renderer.evict_idle(Duration::ZERO);
    assert!(
        snapshots
            .iter()
            .all(|snapshot| snapshot.upgrade().is_none())
    );
    assert_eq!(renderer.state.lock().unwrap().svgs.usage(), (0, 0));
}

#[test]
fn superseded_pdf_is_available_during_grace_then_expires_despite_lease() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("revision.pdf");
    let renderer = NativePdfRenderer::default();
    let mut bytes = pdf_with_nested_outline();
    std::fs::write(&path, &bytes).unwrap();
    let old = revision(&path).unwrap();
    renderer.document(&path, &old).unwrap();
    renderer.set_active_paths([path.clone()]);
    bytes.push(b'\n');
    std::fs::write(&path, &bytes).unwrap();
    let new = revision(&path).unwrap();
    renderer.document(&path, &new).unwrap();
    assert!(renderer.page_svg(&path, &old, 1).is_ok());
    renderer
        .state
        .lock()
        .unwrap()
        .documents
        .get_mut(&(path.clone(), old.clone()))
        .unwrap()
        .superseded_at = Some(Instant::now() - REVISION_GRACE);
    assert!(matches!(
        renderer.page_svg(&path, &old, 1),
        Err(PdfError::Changed)
    ));
    renderer.evict_idle(Duration::ZERO);
    assert!(renderer.page_svg(&path, &new, 1).is_ok());
    assert_eq!(renderer.state.lock().unwrap().documents.len(), 1);
}

#[test]
fn pdf_byte_pressure_rejects_new_load_without_evicting_leased_documents() {
    let root = tempfile::tempdir().unwrap();
    let renderer = NativePdfRenderer::default();
    let paths = (0..3)
        .map(|index| root.path().join(format!("{index}.pdf")))
        .collect::<Vec<_>>();
    renderer.set_active_paths(paths.clone());
    for path in &paths {
        std::fs::write(path, pdf_with_nested_outline()).unwrap();
    }
    for path in &paths[..2] {
        renderer.document(path, &revision(path).unwrap()).unwrap();
    }
    for (_, entry) in renderer.state.lock().unwrap().documents.iter_mut() {
        entry.input_bytes = FILE_LIMIT as usize;
    }
    assert!(matches!(
        renderer.document(&paths[2], &revision(&paths[2]).unwrap()),
        Err(PdfError::Busy)
    ));
    assert_eq!(renderer.state.lock().unwrap().documents.len(), 2);
}

#[test]
fn cancelled_pdf_load_does_not_publish_native_or_svg_cache_entries() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cancelled.pdf");
    std::fs::write(&path, pdf_with_nested_outline()).unwrap();
    let renderer = NativePdfRenderer::default();
    let cancellation = Cancellation::default();
    cancellation.cancel();
    assert!(matches!(
        renderer.document_cancellable(&path, &revision(&path).unwrap(), &cancellation),
        Err(PdfError::Cancelled)
    ));
    assert!(renderer.state.lock().unwrap().documents.is_empty());
    let revision = revision(&path).unwrap();
    renderer.document(&path, &revision).unwrap();
    renderer.clear();
    assert_eq!(renderer.state.lock().unwrap().svgs.usage(), (0, 0));
    assert!(renderer.page_svg(&path, &revision, 1).is_ok());
}

fn pdf_with_nested_outline() -> Vec<u8> {
    let objects = [
            b"<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>".as_slice(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".as_slice(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>".as_slice(),
            b"<< /Type /Outlines /First 5 0 R /Last 5 0 R /Count 2 >>".as_slice(),
            b"<< /Title (Chapter) /Parent 4 0 R /Dest [3 0 R /Fit] /First 6 0 R /Last 6 0 R /Count 1 >>".as_slice(),
            b"<< /Title (Section) /Parent 5 0 R /Dest [3 0 R /Fit] >>".as_slice(),
        ];
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        bytes.extend_from_slice(object);
        bytes.extend_from_slice(b"\nendobj\n");
    }
    let xref_offset = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    bytes.extend_from_slice(b"0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}

#[test]
fn idle_eviction_releases_pdf_and_svg_caches_but_keeps_inflight_snapshot_valid() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("outline.pdf");
    std::fs::write(&path, pdf_with_nested_outline()).unwrap();
    let renderer = NativePdfRenderer::default();
    let revision = revision(&path).unwrap();
    let (snapshot, info) = renderer.snapshot(&path, &revision).unwrap();
    let svg = renderer.page_svg(&path, &revision, 1).unwrap();
    assert!(String::from_utf8_lossy(&svg).contains("background-color: rgba(255, 255, 255, 255);"));
    assert_eq!(info.pages.len(), 1);
    renderer.evict_idle(Duration::ZERO);
    assert_eq!(renderer.state.lock().unwrap().documents.len(), 1);
    assert_eq!(snapshot.pages().len(), 1);
    drop(snapshot);
    renderer.evict_idle(Duration::ZERO);
    let state = renderer.state.lock().unwrap();
    assert!(state.documents.is_empty());
    assert_eq!(state.svgs.usage(), (0, 0));
}

#[test]
fn reads_nested_outline_titles_levels_and_destinations() {
    let pdf = Pdf::new(pdf_with_nested_outline()).expect("test PDF should parse");
    assert_eq!(
        outline(&pdf)
            .into_iter()
            .map(|item| (item.name, item.level, item.page))
            .collect::<Vec<_>>(),
        vec![
            ("Chapter".into(), 1, Some(1)),
            ("Section".into(), 2, Some(1))
        ]
    );
}
