use super::{Availability, Prompt};
use std::{ffi::CString, os::raw::c_char};
use zeroize::Zeroizing;

unsafe extern "C" {
    fn steamguard_mac_access_capabilities() -> i32;
    fn steamguard_mac_access_write(
        namespace: *const c_char,
        slot: *const c_char,
        bytes: *const u8,
        length: usize,
    ) -> i32;
    fn steamguard_mac_access_read(
        namespace: *const c_char,
        slot: *const c_char,
        reason: *const c_char,
        fallback: *const c_char,
        output: *mut *mut u8,
        length: *mut usize,
    ) -> i32;
    fn steamguard_mac_access_remove(namespace: *const c_char, slot: *const c_char) -> i32;
    fn steamguard_mac_access_free(bytes: *mut u8, length: usize);
}

pub struct Desktop {
    namespace: CString,
}
impl Desktop {
    pub fn new(namespace: &str) -> Result<Self, String> {
        if namespace.is_empty() || namespace.len() > 200 {
            return Err("设备认证标识无效".into());
        }
        Ok(Self {
            namespace: CString::new(namespace).map_err(|_| "设备认证标识无效")?,
        })
    }
    pub fn availability(&self) -> Result<Availability, String> {
        let flags = unsafe { steamguard_mac_access_capabilities() };
        Ok(Availability {
            supported: flags & 1 != 0,
            biometric_available: flags & 6 == 6,
            label: "Touch ID".into(),
            unavailable_reason: if flags & 4 == 0 {
                Some("此 macOS 构建尚未配置钥匙串签名授权，请使用主密码或免密码预览。".into())
            } else if flags & 2 == 0 {
                Some("Touch ID 暂不可用，请检查系统设置、已录入的指纹和键盘连接。".into())
            } else {
                None
            },
        })
    }
    pub fn write(&self, slot: &str, data: &str) -> Result<(), String> {
        let slot = checked_slot(slot)?;
        super::validate_data(data)?;
        let status = unsafe {
            steamguard_mac_access_write(
                self.namespace.as_ptr(),
                slot.as_ptr(),
                data.as_ptr(),
                data.len(),
            )
        };
        map_status(status, false)
    }
    pub fn read(&self, slot: &str, prompt: &Prompt) -> Result<String, String> {
        let slot = checked_slot(slot)?;
        let reason = CString::new(prompt.reason.as_str()).map_err(|_| "设备认证提示文本无效")?;
        let fallback =
            CString::new(prompt.fallback.as_str()).map_err(|_| "设备认证提示文本无效")?;
        let mut bytes = std::ptr::null_mut();
        let mut length = 0;
        let status = unsafe {
            steamguard_mac_access_read(
                self.namespace.as_ptr(),
                slot.as_ptr(),
                reason.as_ptr(),
                fallback.as_ptr(),
                &mut bytes,
                &mut length,
            )
        };
        if status != 0 {
            // The bridge leaves no returned allocation on failure.
            map_status(status, true)?;
            return Err("设备密钥不可用，请使用主密码解锁".into());
        }
        if bytes.is_null() || length == 0 || length > 16384 {
            if !bytes.is_null() {
                unsafe { steamguard_mac_access_free(bytes, length) };
            }
            return Err("设备密钥不可用，请使用主密码解锁".into());
        }
        let result = Zeroizing::new(unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec());
        unsafe { steamguard_mac_access_free(bytes, length) };
        std::str::from_utf8(&result)
            .map(str::to_owned)
            .map_err(|_| "设备密钥不可用，请使用主密码解锁".into())
    }
    pub fn remove(&self, slot: &str) -> Result<(), String> {
        let slot = checked_slot(slot)?;
        let status =
            unsafe { steamguard_mac_access_remove(self.namespace.as_ptr(), slot.as_ptr()) };
        map_status(status, false)
    }
}
fn checked_slot(slot: &str) -> Result<CString, String> {
    super::validate_slot(slot)?;
    CString::new(slot).map_err(|_| "未知的解锁选项".into())
}
fn map_status(status: i32, reading: bool) -> Result<(), String> {
    match status {
        0 => Ok(()),
        -34018 => Err("此 macOS 构建尚未配置钥匙串签名授权，请使用主密码或免密码预览。".into()),
        -128 | -25293 | -25300 if reading => Err(
            "验证已取消或设备密钥不可用，请使用主密码解锁；更改系统生物特征后需重新启用。".into(),
        ),
        _ if reading => Err("设备密钥不可用，请使用主密码解锁".into()),
        _ => Err("无法保存或清除设备密钥，请检查系统钥匙串并重试。".into()),
    }
}
