use super::checked_path;
use std::path::Path;

#[cfg(windows)]
#[test]
fn checked_path_accepts_windows_verbatim_prefix() {
    let normalized = checked_path(Path::new(r"\\?\C:\Windows")).unwrap();
    assert_eq!(normalized, Path::new(r"C:\Windows"));
}
