//! Windows Hello is a cryptographic prerequisite for opening the local AEAD
//! envelope, not a UI boolean followed by an ordinary credential-store read.
use super::{sealed, Availability, Prompt};
use std::{
    fs,
    path::{Path, PathBuf},
};
use windows::{
    core::{Interface, HSTRING},
    Security::{
        Credentials::{
            KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
        },
        Cryptography::CryptographicBuffer,
    },
    Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
        System::WinRT::{IBufferByteAccess, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    },
};
use zeroize::{Zeroize, Zeroizing};

const ERROR: &str =
    "验证已取消或设备密钥不可用，请使用主密码解锁；重置 Windows Hello 后需重新启用。";
#[derive(Clone)]
pub struct Desktop {
    namespace: String,
    directory: PathBuf,
}
impl Desktop {
    pub fn new(namespace: &str, directory: PathBuf) -> Result<Self, String> {
        if namespace.is_empty() || namespace.len() > 200 || namespace.chars().any(char::is_control)
        {
            return Err("设备认证标识无效".into());
        }
        Ok(Self {
            namespace: namespace.into(),
            directory,
        })
    }
    pub fn availability(&self) -> Result<Availability, String> {
        let biometric_available = worker(|| KeyCredentialManager::IsSupportedAsync()?.join())
            .ok()
            .and_then(Result::ok)
            .unwrap_or(false);
        Ok(Availability {
            supported: true,
            biometric_available,
            label: "Windows Hello".into(),
            unavailable_reason: (!biometric_available)
                .then(|| "请先在 Windows 设置中启用 Windows Hello PIN、指纹或人脸识别。".into()),
        })
    }
    fn key_name(&self) -> HSTRING {
        HSTRING::from(format!("{}.quick-access.biometric.v1", self.namespace))
    }
    fn path(&self, slot: &str) -> Result<PathBuf, String> {
        super::validate_slot(slot)?;
        Ok(self.directory.join(format!("{slot}.windows-protected")))
    }
    pub fn write(&self, slot: &str, data: &str) -> Result<(), String> {
        super::validate_data(data)?;
        let path = self.path(slot)?;
        if slot == "preview" {
            let ciphertext = dpapi(data.as_bytes(), self.namespace.as_bytes(), true)?;
            return write_file(&path, &ciphertext);
        }
        let this = self.clone();
        let data = Zeroizing::new(data.to_owned());
        worker(move || -> Result<(), String> {
            let name = this.key_name();
            let result = KeyCredentialManager::RequestCreateAsync(
                &name,
                KeyCredentialCreationOption::FailIfExists,
            )
            .map_err(|_| ERROR)?
            .join()
            .map_err(|_| ERROR)?;
            if result.Status().map_err(|_| ERROR)? != KeyCredentialStatus::Success {
                return Err(ERROR.into());
            }
            let created = result.Credential().map_err(|_| ERROR)?;
            let operation = (|| {
                let challenge = sealed::random_challenge();
                let message = sealed::signing_challenge(&this.namespace, &challenge);
                let key = sign_key(&created, &message)?;
                // The detailed Windows Hello guide specifies deterministic
                // RSA/SHA256 PKCS#1 signatures. Refuse enrollment if a future
                // provider instead produces nondeterministic signatures.
                let repeated = sign_key(&created, &message)?;
                if *key != *repeated {
                    return Err(
                        "此 Windows Hello 提供程序无法保护本地解锁密钥，请使用主密码。".into(),
                    );
                }
                let envelope = sealed::seal(&this.namespace, challenge, &key, &data)?;
                let bytes = serde_json::to_vec(&envelope).map_err(|_| ERROR)?;
                write_file(&path, &bytes)
            })();
            if operation.is_err() {
                let _ = KeyCredentialManager::DeleteAsync(&name).and_then(|op| op.join());
            }
            operation
        })?
    }
    pub fn read(&self, slot: &str, _prompt: &Prompt) -> Result<String, String> {
        let path = self.path(slot)?;
        let bytes = read_file(&path)?;
        if slot == "preview" {
            let plaintext = Zeroizing::new(dpapi(&bytes, self.namespace.as_bytes(), false)?);
            return std::str::from_utf8(&plaintext)
                .map(str::to_owned)
                .map_err(|_| ERROR.into());
        }
        let this = self.clone();
        worker(move || -> Result<String, String> {
            let envelope: sealed::Envelope = serde_json::from_slice(&bytes).map_err(|_| ERROR)?;
            // Open only: a lost or reset Hello key must not silently create a
            // replacement key and pretend an existing vault can be unlocked.
            let result = KeyCredentialManager::OpenAsync(&this.key_name())
                .map_err(|_| ERROR)?
                .join()
                .map_err(|_| ERROR)?;
            if result.Status().map_err(|_| ERROR)? != KeyCredentialStatus::Success {
                return Err(ERROR.into());
            }
            let credential = result.Credential().map_err(|_| ERROR)?;
            let message = sealed::signing_challenge(&this.namespace, &envelope.challenge);
            let key = sign_key(&credential, &message)?;
            sealed::open(&this.namespace, &envelope, &key)
        })?
    }
    pub fn remove(&self, slot: &str) -> Result<(), String> {
        let path = self.path(slot)?;
        // Delete ciphertext before asking Windows to forget the provider key.
        // A failure therefore cannot leave an accessible enabled credential.
        match fs::remove_file(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("无法清除设备密钥，请重试".into()),
        }
        if slot == "biometric" {
            let name = self.key_name();
            worker(move || -> windows::core::Result<()> {
                let existing = KeyCredentialManager::OpenAsync(&name)?.join()?;
                if existing.Status()? == KeyCredentialStatus::NotFound {
                    return Ok(());
                }
                if existing.Status()? != KeyCredentialStatus::Success {
                    return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                        0x80004005u32 as i32,
                    )));
                }
                KeyCredentialManager::DeleteAsync(&name)?.join()
            })?
            .map_err(|_| "无法清除 Windows Hello 密钥，请重试")?;
        }
        Ok(())
    }
}

// All WinRT async operations complete on a private MTA worker. Blocking an STA
// UI thread can deadlock the system consent dialog. No window/package identity
// from a UWP CoreWindow is required by this desktop KeyCredential API path.
fn worker<T: Send + 'static, E: Send + 'static>(
    operation: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<Result<T, E>, String> {
    std::thread::spawn(move || {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| ERROR)?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { RoUninitialize() };
            }
        }
        let _apartment = Apartment;
        Ok(operation())
    })
    .join()
    .map_err(|_| ERROR.to_owned())?
}
fn sign_key(credential: &KeyCredential, message: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let buffer = CryptographicBuffer::CreateFromByteArray(message).map_err(|_| ERROR)?;
    let signed = credential
        .RequestSignAsync(&buffer)
        .map_err(|_| ERROR)?
        .join()
        .map_err(|_| ERROR)?;
    if signed.Status().map_err(|_| ERROR)? != KeyCredentialStatus::Success {
        return Err(ERROR.into());
    }
    let signature = signed.Result().map_err(|_| ERROR)?;
    let length = signature.Length().map_err(|_| ERROR)? as usize;
    let access = signature.cast::<IBufferByteAccess>().map_err(|_| ERROR)?;
    let pointer = unsafe { access.Buffer() }.map_err(|_| ERROR)?;
    if pointer.is_null() || length > 8192 {
        return Err(ERROR.into());
    }
    // The WinRT signature buffer itself is scrubbed, not merely a Rust copy.
    let bytes = unsafe { std::slice::from_raw_parts_mut(pointer, length) };
    let key = sealed::derive_key(bytes);
    bytes.zeroize();
    key
}
fn dpapi(data: &[u8], entropy: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() > 32768 {
        return Err(ERROR.into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let status = if encrypt {
            CryptProtectData(
                &input,
                windows::core::PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        status.map_err(|_| ERROR)?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err(ERROR.into());
        }
        let buffer = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = buffer.to_vec();
        buffer.zeroize();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}
fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|_| ERROR)?;
    if file.metadata().map_err(|_| ERROR)?.len() > 65536 {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| ERROR)?;
    if bytes.len() > 65536 {
        return Err(ERROR.into());
    }
    Ok(bytes)
}
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(path.parent().ok_or(ERROR)?).map_err(|_| ERROR)?;
    // create_new refuses symlinks and stale partial files. Never truncate an
    // arbitrary path. Parent is the app's user-scoped LocalAppData directory.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| ERROR)?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(ERROR.into());
    }
    Ok(())
}
