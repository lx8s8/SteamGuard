use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{GlobalFree, HANDLE, HWND},
        System::{DataExchange::*, Memory::*},
    },
};
use zeroize::Zeroizing;
const ERROR: &str = "无法复制验证码";
struct Lock;
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}
unsafe fn open(window: Option<HWND>) -> Result<Lock, String> {
    // Another application may briefly own the clipboard lock.
    for _ in 0..5 {
        if unsafe { OpenClipboard(window) }.is_ok() {
            return Ok(Lock);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(ERROR.into())
}
unsafe fn put(format: u32, bytes: &[u8]) -> Result<(), String> {
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }.map_err(|_| ERROR)?;
    let target = unsafe { GlobalLock(memory) };
    if target.is_null() {
        unsafe {
            let _ = GlobalFree(Some(memory));
        }
        return Err(ERROR.into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(memory);
    }
    if unsafe { SetClipboardData(format, Some(HANDLE(memory.0))) }.is_err() {
        unsafe {
            let _ = GlobalFree(Some(memory));
        }
        return Err(ERROR.into());
    }
    // SetClipboardData transfers ownership of the HGLOBAL to Windows.
    Ok(())
}
pub fn write(window: usize, text: &str) -> Result<u32, String> {
    if window == 0 {
        return Err(ERROR.into());
    }
    let utf16 = Zeroizing::new(text.encode_utf16().chain(Some(0)).collect::<Vec<_>>());
    unsafe {
        let _lock = open(Some(HWND(window as *mut _)))?;
        EmptyClipboard().map_err(|_| ERROR)?;
        // Add privacy flags before the text so history monitors never observe
        // an intermediate text-only clipboard publication.
        for name in [
            "ExcludeClipboardContentFromMonitorProcessing",
            "CanIncludeInClipboardHistory",
            "CanUploadToCloudClipboard",
        ] {
            let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            let format = RegisterClipboardFormatW(PCWSTR(name.as_ptr()));
            if format == 0 || put(format, &0u32.to_le_bytes()).is_err() {
                let _ = EmptyClipboard();
                return Err(ERROR.into());
            }
        }
        let bytes = std::slice::from_raw_parts(utf16.as_ptr().cast::<u8>(), utf16.len() * 2);
        if put(13, bytes).is_err() {
            let _ = EmptyClipboard();
            return Err(ERROR.into());
        }
        Ok(GetClipboardSequenceNumber())
    }
}
pub fn clear(owner: u32) -> Result<bool, String> {
    unsafe {
        let _lock = open(None).map_err(|_| "暂时无法清除剪贴板")?;
        if GetClipboardSequenceNumber() != owner {
            return Ok(false);
        }
        EmptyClipboard().map_err(|_| "暂时无法清除剪贴板")?;
        Ok(true)
    }
}
