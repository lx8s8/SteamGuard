//! Password-protected Aegis and 2FAS backup readers.
//! Formats: Aegis docs/vault.md; 2FAS Android BackupCipherImpl/DataEncrypted.
//! Decryption stays native. Untrusted KDF parameters and file sizes are bounded.
use super::{Json, MAX_IMPORT_BYTES};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use zeroize::Zeroizing;

pub struct SecretJson(pub Json);
impl Drop for SecretJson {
    fn drop(&mut self) {
        crate::vault::wipe_json(&mut self.0);
    }
}

pub fn detect(value: &Json, password: Option<&str>) -> Option<Result<SecretJson, String>> {
    if value.get("db").is_some_and(Json::is_string) && value.get("version").is_some() {
        Some(aegis(value, password))
    } else if value
        .get("servicesEncrypted")
        .and_then(Json::as_str)
        .is_some_and(|s| !s.is_empty())
        || value
            .get("reference")
            .and_then(Json::as_str)
            .is_some_and(|s| !s.is_empty())
    {
        Some(twofas(value, password))
    } else {
        None
    }
}
fn password(value: Option<&str>) -> Result<&str, String> {
    value
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "这是加密备份，请输入导出时设置的密码".into())
}
fn text<'a>(v: &'a Json, key: &str) -> Result<&'a str, String> {
    v.get(key)
        .and_then(Json::as_str)
        .ok_or_else(|| "加密备份的参数不完整".into())
}
fn number(v: &Json, key: &str) -> Result<u64, String> {
    v.get(key)
        .and_then(Json::as_u64)
        .ok_or_else(|| "加密备份的数字参数无效".into())
}
fn hex(v: &str, length: usize) -> Result<Zeroizing<Vec<u8>>, String> {
    if v.len() != length * 2 {
        return Err("加密备份的十六进制参数长度无效".into());
    }
    let mut out = Zeroizing::new(Vec::with_capacity(length));
    for pair in v.as_bytes().chunks_exact(2) {
        let digit = |b: u8| -> Option<u8> {
            match b {
                b'0'..=b'9' => Some(b - b'0'),
                b'a'..=b'f' => Some(b - b'a' + 10),
                b'A'..=b'F' => Some(b - b'A' + 10),
                _ => None,
            }
        };
        out.push(
            digit(pair[0])
                .zip(digit(pair[1]))
                .map(|(a, b)| a * 16 + b)
                .ok_or("加密备份包含无效的十六进制参数")?,
        );
    }
    Ok(out)
}
fn base64(v: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if v.len() > MAX_IMPORT_BYTES {
        return Err("加密备份超过大小限制".into());
    }
    let compact = Zeroizing::new(
        v.bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .collect::<Vec<_>>(),
    );
    STANDARD
        .decode(&*compact)
        .or_else(|_| STANDARD_NO_PAD.decode(&*compact))
        .map(Zeroizing::new)
        .map_err(|_| "加密备份包含无效的 Base64 参数".into())
}
fn decrypt(key: &[u8], nonce: &[u8], cipher: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    if key.len() != 32 || nonce.len() != 12 || cipher.len() < 16 || cipher.len() > MAX_IMPORT_BYTES
    {
        return Err("加密备份的密钥、随机数或密文长度无效".into());
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "加密备份的密钥长度无效")?
        .decrypt(Nonce::from_slice(nonce), cipher)
        .map(Zeroizing::new)
        .map_err(|_| "备份解密失败：密码错误或文件已损坏".into())
}
fn detached(
    key: &[u8],
    params: &Json,
    mut cipher: Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = hex(text(params, "nonce")?, 12)?;
    let tag = hex(text(params, "tag")?, 16)?;
    cipher.extend_from_slice(&tag);
    decrypt(key, &nonce, &cipher)
}
fn aegis(value: &Json, supplied: Option<&str>) -> Result<SecretJson, String> {
    if value["version"].as_u64() != Some(1) {
        return Err("不支持的 Aegis 备份版本".into());
    }
    let password = password(supplied)?;
    let header = value.get("header").ok_or("Aegis 备份缺少加密头")?;
    let slots = header
        .get("slots")
        .and_then(Json::as_array)
        .filter(|s| !s.is_empty() && s.len() <= 32)
        .ok_or("Aegis 备份的密码槽无效")?;
    // Limit peak allocation to 64 MiB and cumulative work across slots. Aegis defaults
    // (N=32768,r=8,p=1) require 32 MiB; malicious files cannot request arbitrary RAM.
    let mut work = 0_u64;
    let mut candidates = vec![];
    for slot in slots.iter().filter(|s| s["type"].as_u64() == Some(1)) {
        let n = number(slot, "n")?;
        let r = number(slot, "r")?;
        let p = number(slot, "p")?;
        let nr = n.checked_mul(r).ok_or("Aegis 密钥派生参数超过限制")?;
        let cost = nr.checked_mul(p).ok_or("Aegis 密钥派生参数超过限制")?;
        work = work.checked_add(cost).ok_or("Aegis 密钥派生参数超过限制")?;
        if !n.is_power_of_two()
            || n < 2
            || r == 0
            || p == 0
            || nr > 524288
            || work > 1048576
            || candidates.len() >= 8
        {
            return Err("Aegis 密钥派生参数超过限制，请使用默认加密参数重新导出".into());
        }
        let r = u32::try_from(r).map_err(|_| "Aegis 密钥派生参数超过限制")?;
        let p = u32::try_from(p).map_err(|_| "Aegis 密钥派生参数超过限制")?;
        let params = scrypt::Params::new(n.trailing_zeros() as u8, r, p, 32)
            .map_err(|_| "Aegis 密钥派生参数无效")?;
        let salt = hex(text(slot, "salt")?, 32)?;
        let encrypted = hex(text(slot, "key")?, 32)?;
        candidates.push((slot, params, salt, encrypted));
    }
    if candidates.is_empty() {
        return Err("Aegis 备份没有可用的密码槽，请在原应用添加密码后重新导出".into());
    }
    let cipher = base64(text(value, "db")?)?;
    for (slot, params, salt, encrypted) in candidates {
        let mut derived = Zeroizing::new([0u8; 32]);
        scrypt::scrypt(password.as_bytes(), &salt, &params, &mut *derived)
            .map_err(|_| "Aegis 密钥派生失败")?;
        // A wrong password can fail one slot while another slot is valid.
        let Ok(master) = detached(&*derived, &slot["key_params"], encrypted) else {
            continue;
        };
        if master.len() != 32 {
            return Err("Aegis 主密钥长度无效".into());
        }
        let plain = detached(&master, &header["params"], Zeroizing::new(cipher.to_vec()))?;
        let db: Json = serde_json::from_slice(&plain).map_err(|_| "Aegis 解密内容不是有效 JSON")?;
        let mut normalized = SecretJson(value.clone());
        normalized.0["db"] = db;
        return Ok(normalized);
    }
    Err("备份解密失败：密码错误或文件已损坏".into())
}
// The public reference marker defined by the 2FAS backup format, not a credential.
const TWOFAS_REFERENCE: &str = "tRViSsLKzd86Hprh4ceC2OP7xazn4rrt4xhfEUbOjxLX8Rc3mkISXE0lWbmnWfggogbBJhtYgpK6fMl1D6mtsy92R3HkdGfwuXbzLebqVFJsR7IZ2w58t938iymwG4824igYy1wi6n2WDpO1Q1P69zwJGs2F5a1qP4MyIiDSD7NCV2OvidXQCBnDlGfmz0f1BQySRkkt4ryiJeCjD2o4QsveJ9uDBUn8ELyOrESv5R5DMDkD4iAF8TXU7KyoJujd";
fn twofas_part(value: &str, password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let parts: Vec<_> = value.split(':').collect();
    if parts.len() != 3 {
        return Err("2FAS 加密备份参数格式无效".into());
    }
    let cipher = base64(parts[0])?;
    let salt = base64(parts[1])?;
    let nonce = base64(parts[2])?;
    if !(16..=1024).contains(&salt.len()) {
        return Err("2FAS 加密备份盐值长度无效".into());
    }
    let mut key = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(password.as_bytes(), &salt, 10000, &mut *key);
    decrypt(&*key, &nonce, &cipher)
}
fn twofas(value: &Json, supplied: Option<&str>) -> Result<SecretJson, String> {
    let version = value
        .get("schemaVersion")
        .and_then(Json::as_u64)
        .unwrap_or(1);
    if !(1..=4).contains(&version) {
        return Err("不支持的 2FAS 备份版本".into());
    }
    let password = password(supplied)?;
    let reference = twofas_part(text(value, "reference")?, password)?;
    if reference.as_slice() != TWOFAS_REFERENCE.as_bytes() {
        return Err("2FAS 备份校验失败：密码错误或文件已损坏".into());
    }
    let plain = twofas_part(text(value, "servicesEncrypted")?, password)?;
    let services: Json =
        serde_json::from_slice(&plain).map_err(|_| "2FAS 解密内容不是有效 JSON")?;
    let mut normalized = SecretJson(value.clone());
    normalized.0["services"] = services;
    normalized.0["servicesEncrypted"] = Json::Null;
    normalized.0["reference"] = Json::Null;
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Independent Node crypto fixtures with RFC test-only OTP seed; never production data.
    const PASSWORD: &str = "synthetic-only-password-🔐";
    const AEGIS: &[u8] = include_bytes!("../../tests/fixtures/aegis-encrypted-synthetic.json");
    const TWOFAS: &[u8] = include_bytes!("../../tests/fixtures/twofas-encrypted-synthetic.2fas");
    #[test]
    fn independent_aegis_fixture_preserves_hotp_group_and_algorithm() {
        let tokens = super::super::parse_import(AEGIS, Some(PASSWORD), "aegis.json").unwrap();
        assert_eq!(tokens.len(), 1);
        let t = &tokens[0];
        assert_eq!(
            (&*t.name, &*t.issuer, &*t.kind, &*t.algorithm),
            ("Synthetic Account", "Example", "hotp", "SHA256")
        );
        assert_eq!((t.digits, t.counter), (8, 42));
        assert_eq!(t.secret, b"1234567890");
        assert!(t.pinned);
        assert_eq!(t.group.as_deref(), Some("Synthetic Group"));
    }
    #[test]
    fn independent_twofas_fixture_supports_separate_salts_and_unicode_password() {
        let tokens = super::super::parse_import(TWOFAS, Some(PASSWORD), "twofas.2fas").unwrap();
        assert_eq!(tokens.len(), 1);
        let t = &tokens[0];
        assert_eq!((&*t.name, &*t.algorithm), ("Synthetic Account", "SHA512"));
        assert_eq!((t.digits, t.period), (8, 60));
        assert_eq!(t.group.as_deref(), Some("Synthetic Group"));
    }
    #[test]
    fn encrypted_backups_require_password_and_reject_wrong_password_or_tampering() {
        for bytes in [AEGIS, TWOFAS] {
            assert!(super::super::parse_import(bytes, None, "backup")
                .err()
                .unwrap()
                .contains("输入"));
            assert!(
                super::super::parse_import(bytes, Some("incorrect"), "backup")
                    .err()
                    .unwrap()
                    .contains("密码错误")
            );
            let mut v: Json = serde_json::from_slice(bytes).unwrap();
            if v.get("db").is_some() {
                v["header"]["params"]["tag"] = Json::String("00".repeat(16));
            } else {
                let data = v["servicesEncrypted"].as_str().unwrap();
                v["servicesEncrypted"] = Json::String(format!("A{}", &data[1..]));
            }
            let damaged = serde_json::to_vec(&v).unwrap();
            assert!(super::super::parse_import(&damaged, Some(PASSWORD), "backup").is_err());
        }
    }
    #[test]
    fn malicious_kdf_parameters_are_rejected_before_allocating() {
        let mut v: Json = serde_json::from_slice(AEGIS).unwrap();
        for (n, r, p) in [
            (1u64 << 30, 8, 1),
            (32768, 8, u64::MAX),
            (3, 8, 1),
            (32768, 0, 1),
            (2, 1, u64::MAX),
        ] {
            v["header"]["slots"][0]["n"] = n.into();
            v["header"]["slots"][0]["r"] = r.into();
            v["header"]["slots"][0]["p"] = p.into();
            assert!(aegis(&v, Some(PASSWORD)).err().unwrap().contains("限制"));
        }
        let slot: Json =
            serde_json::from_slice::<Json>(AEGIS).unwrap()["header"]["slots"][0].clone();
        v["header"]["slots"] = Json::Array(vec![slot; 5]);
        assert!(aegis(&v, Some(PASSWORD)).err().unwrap().contains("限制"));
    }
    #[test]
    fn missing_password_slot_and_invalid_twofas_envelope_are_rejected() {
        let mut v: Json = serde_json::from_slice(AEGIS).unwrap();
        v["header"]["slots"][0]["type"] = 2.into();
        assert!(aegis(&v, Some(PASSWORD)).err().unwrap().contains("密码槽"));
        for invalid in ["a:b:c:d", "AAAA:AA==:AAAA", "invalid"] {
            assert!(twofas_part(invalid, PASSWORD).is_err());
        }
        v = serde_json::from_slice(TWOFAS).unwrap();
        v["schemaVersion"] = 5.into();
        assert!(twofas(&v, Some(PASSWORD)).is_err());
    }
}
