use std::{io, os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
    UI::{
        Shell::{
            SEE_MASK_FLAG_LOG_USAGE, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
            ShellExecuteExW,
        },
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

pub(super) fn open(path: &Path) -> io::Result<()> {
    let mut file: Vec<u16> = dunce::simplified(path).as_os_str().encode_wide().collect();
    if file.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid file path",
        ));
    }
    file.push(0);
    // Run on a blocking worker: Shell extensions can use COM and DDE. NOASYNC
    // completes dispatch without requiring this thread to run a message loop.
    // No process handle is requested, so reused applications work as well.
    unsafe {
        let initialized = CoInitializeEx(ptr::null(), COINIT_APARTMENTTHREADED as u32);
        if initialized < 0 {
            return Err(io::Error::other(format!(
                "Could not initialize system opener: HRESULT {initialized:#x}"
            )));
        }
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI | SEE_MASK_FLAG_LOG_USAGE,
            lpFile: file.as_ptr(),
            nShow: SW_SHOWNORMAL,
            ..std::mem::zeroed()
        };
        // A null verb uses the registered default action. LOG_USAGE marks this
        // as user initiated; Windows still controls foreground activation.
        let result = if ShellExecuteExW(&mut info) != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        };
        CoUninitialize();
        result
    }
}
