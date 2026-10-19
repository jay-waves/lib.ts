//! Host/Origin validation is a browser request boundary, not user authentication.
//! Load access.json once at startup; public URLs do not implicitly whitelist hosts.
//! Proxy protocol comes from configuration, not untrusted forwarded headers.
use axum::http::{HeaderMap, Method, Uri, header, uri::Authority};
use serde::Deserialize;
use std::{collections::HashSet, net::IpAddr, path::Path};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    #[serde(default)]
    allowed_hosts: Vec<String>,
}

pub struct AccessPolicy {
    hosts: HashSet<String>,
    scheme: String,
}

impl AccessPolicy {
    pub fn load(directory: &Path, hostname: &str, public_url: &str) -> Result<Self, String> {
        let path = directory.join("access.json");
        let config = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Config>(&bytes)
                .map_err(|error| format!("{}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        let scheme = public_url
            .parse::<Uri>()
            .ok()
            .and_then(|uri| uri.scheme_str().map(str::to_owned))
            .filter(|scheme| matches!(scheme.as_str(), "http" | "https"))
            .ok_or("Public URL must use http or https")?;
        let mut hosts = HashSet::from(["localhost".into(), normalize_host(hostname)?]);
        for value in config.allowed_hosts {
            let host = if let Ok(ip) = value.parse::<IpAddr>() {
                ip.to_string()
            } else {
                let authority = parse_authority(&value)?;
                if authority.port().is_some() {
                    return Err(format!(
                        "{}: allowedHosts entries must omit ports",
                        path.display()
                    ));
                }
                normalize_host(authority.host())?
            };
            hosts.insert(host);
        }
        Ok(Self { hosts, scheme })
    }

    pub fn check(&self, headers: &HeaderMap, method: &Method) -> Result<(), &'static str> {
        let host = single_header(headers, header::HOST).ok_or("Missing or duplicate Host")?;
        let authority = parse_authority(host).map_err(|_| "Invalid Host")?;
        let name = normalize_host(authority.host()).map_err(|_| "Invalid Host")?;
        let local_ip = name.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
        let local_name = name == "localhost" || name.ends_with(".localhost");
        if !local_ip && !local_name && !self.hosts.contains(&name) {
            return Err("Host is not allowed");
        }
        let origin = single_header(headers, header::ORIGIN);
        if !headers.contains_key(header::ORIGIN) && matches!(*method, Method::GET | Method::HEAD) {
            return Ok(());
        }
        let origin = origin.ok_or("Missing or duplicate Origin")?;
        let prefix = format!("{}://", self.scheme);
        let origin = origin
            .strip_prefix(&prefix)
            .ok_or("Origin scheme is not allowed")?;
        let origin = parse_authority(origin).map_err(|_| "Invalid Origin")?;
        let origin_name = normalize_host(origin.host()).map_err(|_| "Invalid Origin")?;
        let default_port = if self.scheme == "https" { 443 } else { 80 };
        if name != origin_name
            || authority.port_u16().unwrap_or(default_port)
                != origin.port_u16().unwrap_or(default_port)
        {
            return Err("Cross-origin request is forbidden");
        }
        Ok(())
    }
}

fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        None
    } else {
        Some(value)
    }
}

fn parse_authority(value: &str) -> Result<Authority, String> {
    if value.is_empty() || value.ends_with(':') || value.contains(['@', '/', '\\', '?', '#', '*']) {
        return Err(format!("Invalid host authority: {value}"));
    }
    let authority = value
        .parse::<Authority>()
        .map_err(|_| format!("Invalid host: {value}"))?;
    let suffix = value.strip_prefix(authority.host()).ok_or("Invalid host")?;
    if (!value.starts_with('[') && authority.host().contains(':'))
        || (!suffix.is_empty()
            && !suffix.strip_prefix(':').is_some_and(|port| {
                !port.is_empty()
                    && port.bytes().all(|c| c.is_ascii_digit())
                    && port.parse::<u16>().is_ok()
            }))
    {
        return Err(format!("Invalid host port: {value}"));
    }
    Ok(authority)
}

fn normalize_host(value: &str) -> Result<String, String> {
    let name = value.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = name.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty()
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'.'))
    {
        return Err(format!("Invalid hostname: {value}"));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(extra: &[&str]) -> AccessPolicy {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("access.json"),
            serde_json::json!({"allowedHosts":extra}).to_string(),
        )
        .unwrap();
        AccessPolicy::load(directory.path(), "my-pc", "http://localhost:49191").unwrap()
    }

    fn headers(host: &str, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, host.parse().unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
        }
        headers
    }

    #[test]
    fn local_and_configured_hosts_are_exact_and_origins_match_ports() {
        let policy = policy(&["192.168.0.163", "notes.example", "2001:db8::1"]);
        for host in [
            "localhost:49191",
            "lib.localhost:49191",
            "nested.lib.localhost:49191",
            "LIB.LOCALHOST.:49191",
            "127.0.0.1:49191",
            "[::1]:49191",
            "MY-PC:49191",
            "192.168.0.163:49191",
            "notes.example:49191",
            "[2001:db8::1]:49191",
        ] {
            assert!(
                policy
                    .check(
                        &headers(host, Some(&format!("http://{host}"))),
                        &Method::POST
                    )
                    .is_ok(),
                "{host}"
            );
        }
        assert!(
            policy
                .check(
                    &headers("localhost:80", Some("http://localhost")),
                    &Method::POST
                )
                .is_ok()
        );
        for (host, origin) in [
            ("evil.example", "http://evil.example"),
            ("sub.notes.example", "http://sub.notes.example"),
            ("lib.localhost.evil", "http://lib.localhost.evil"),
            ("evil-localhost", "http://evil-localhost"),
            ("lib.localhost:49191", "http://localhost:49191"),
            ("lib.localhost:49191", "http://other.localhost:49191"),
            ("localhost:49191", "http://localhost:49192"),
            ("localhost:49191", "http://127.0.0.1:49191"),
            ("localhost:49191", "https://localhost:49191"),
        ] {
            assert!(
                policy
                    .check(&headers(host, Some(origin)), &Method::POST)
                    .is_err()
            );
        }
    }

    #[test]
    fn missing_null_malformed_and_duplicate_headers_are_rejected() {
        let policy = policy(&[]);
        assert!(
            policy
                .check(&headers("localhost", None), &Method::GET)
                .is_ok()
        );
        assert!(policy.check(&HeaderMap::new(), &Method::GET).is_err());
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            assert!(policy.check(&headers("localhost", None), &method).is_err());
        }
        for origin in [
            "null",
            "http://localhost/",
            "http://localhost/path",
            "http://user@localhost",
            "http://localhost:invalid",
            "http://localhost?x=1",
            "http://evil.example",
        ] {
            assert!(
                policy
                    .check(&headers("localhost", Some(origin)), &Method::GET)
                    .is_err(),
                "{origin}"
            );
        }
        let mut duplicate = headers("localhost", Some("http://localhost"));
        duplicate.append(header::ORIGIN, "http://localhost".parse().unwrap());
        assert!(policy.check(&duplicate, &Method::POST).is_err());
        let mut duplicate = headers("localhost", Some("http://localhost"));
        duplicate.append(header::HOST, "evil.example".parse().unwrap());
        assert!(policy.check(&duplicate, &Method::GET).is_err());
        let mut forwarded = headers("localhost", Some("https://localhost"));
        forwarded.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(policy.check(&forwarded, &Method::POST).is_err());
        assert!(
            policy
                .check(&headers("192.168.0.163", None), &Method::GET)
                .is_err()
        );
        for host in [
            "localhost:65536",
            "localhost:invalid",
            "user@localhost",
            "localhost.evil",
            "http://localhost",
            "localhost:",
        ] {
            assert!(
                policy.check(&headers(host, None), &Method::GET).is_err(),
                "{host}"
            );
        }
    }

    #[test]
    fn https_origin_uses_public_configuration_not_forwarded_headers() {
        let directory = tempfile::tempdir().unwrap();
        let policy = AccessPolicy::load(directory.path(), "my-pc", "https://localhost").unwrap();
        assert!(
            policy
                .check(
                    &headers("localhost:443", Some("https://localhost")),
                    &Method::POST
                )
                .is_ok()
        );
        assert!(
            policy
                .check(
                    &headers("localhost:443", Some("http://localhost:443")),
                    &Method::POST
                )
                .is_err()
        );
    }

    #[test]
    fn offline_config_fails_closed_on_invalid_content() {
        let directory = tempfile::tempdir().unwrap();
        assert!(AccessPolicy::load(directory.path(), "my-pc", "http://localhost").is_ok());
        for json in [
            "{",
            r#"{"allowedHost":[]}"#,
            r#"{"allowedHosts":["*"]}"#,
            r#"{"allowedHosts":["http://evil.example"]}"#,
            r#"{"allowedHosts":["localhost:49191"]}"#,
        ] {
            std::fs::write(directory.path().join("access.json"), json).unwrap();
            assert!(
                AccessPolicy::load(directory.path(), "my-pc", "http://localhost").is_err(),
                "{json}"
            );
        }
    }
}
