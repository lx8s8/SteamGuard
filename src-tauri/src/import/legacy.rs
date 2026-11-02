//! WinAuth password protection and WattToolkit v1 transport.
//! Reference: WinAuth Authenticator.Encrypt/DecryptSequence and WinAuthConfig.ReadXmlInternal.
//! The legacy cipher is compatibility-only; new backups use the authenticated vault format.
use super::{decode_hex, MAX_IMPORT_BYTES};
use aes::cipher::{generic_array::GenericArray, BlockDecrypt};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::bufread::GzDecoder;
use sha2::{Digest, Sha256};
use std::io::Read;
use zeroize::Zeroizing;

pub(super) struct SecretMp(pub super::Mp);
impl Drop for SecretMp {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        fn wipe(value: &mut super::Mp) {
            match value {
                super::Mp::String(s) => {
                    // rmpv's string wrapper does not expose mutable bytes.
                    let mut original = std::mem::replace(s, "".into()).into_bytes();
                    original.zeroize();
                }
                super::Mp::Binary(v) | super::Mp::Ext(_, v) => v.zeroize(),
                super::Mp::Array(v) => v.iter_mut().for_each(wipe),
                super::Mp::Map(v) => v.iter_mut().for_each(|(k, v)| {
                    wipe(k);
                    wipe(v);
                }),
                _ => {}
            }
        }
        wipe(&mut self.0);
    }
}

#[derive(Default)]
pub(super) struct SecretTokens(pub Vec<crate::models::Token>);
impl Drop for SecretTokens {
    fn drop(&mut self) {
        self.0.iter_mut().for_each(crate::models::Token::erase);
    }
}
pub(super) struct SecretToken(Option<crate::models::Token>);
impl SecretToken {
    pub fn new(token: crate::models::Token) -> Self {
        Self(Some(token))
    }
    pub fn take(mut self) -> crate::models::Token {
        self.0.take().unwrap()
    }
}
impl std::ops::Deref for SecretToken {
    type Target = crate::models::Token;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for SecretToken {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}
impl Drop for SecretToken {
    fn drop(&mut self) {
        if let Some(token) = self.0.as_mut() {
            token.erase();
        }
    }
}

const MAX_ENCRYPTED_NODES: usize = 1000;
const MAX_NESTING: usize = 4;
const DECRYPT_ERROR: &str = "WinAuth 解密失败：密码错误或文件损坏";

pub fn dat(data: &[u8]) -> Result<Zeroizing<String>, String> {
    // StringExtensions.DecompressString is Base64(GZip(UTF8 XML)).
    let encoded = Zeroizing::new(
        data.iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .collect::<Vec<_>>(),
    );
    let compressed = Zeroizing::new(
        STANDARD
            .decode(&*encoded)
            .map_err(|_| "WattToolkit v1 DAT 的 Base64 数据无效")?,
    );
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut plain = Zeroizing::new(Vec::new());
    (&mut decoder)
        .take(MAX_IMPORT_BYTES as u64 + 1)
        .read_to_end(&mut plain)
        .map_err(|_| "WattToolkit v1 DAT 的 GZip 数据损坏")?;
    if plain.is_empty() || plain.len() > MAX_IMPORT_BYTES {
        return Err("DAT 解压后为空或超过 16 MiB 限制".into());
    }
    if !decoder.get_ref().is_empty() {
        return Err("DAT 包含无效的尾部压缩数据".into());
    }
    let value = std::str::from_utf8(&plain).map_err(|_| "DAT 内容不是 UTF-8 XML")?;
    let value = value.trim_start_matches('\u{feff}').trim();
    if !value.starts_with('<') {
        return Err("DAT 内容不是 WinAuth XML".into());
    }
    Ok(Zeroizing::new(value.to_owned()))
}

pub fn xml(text: &str, password: Option<&str>) -> Result<Zeroizing<String>, String> {
    let mut budget = Budget { nodes: 0, bytes: 0 };
    expand(text, password, 0, &mut budget)
}

struct Budget {
    nodes: usize,
    bytes: usize,
}

fn protected(node: roxmltree::Node<'_, '_>) -> bool {
    node.attribute("encrypted")
        .is_some_and(|v| !v.is_empty() && v != "false")
}

fn expand(
    text: &str,
    password: Option<&str>,
    depth: usize,
    budget: &mut Budget,
) -> Result<Zeroizing<String>, String> {
    if depth > MAX_NESTING || text.len() > MAX_IMPORT_BYTES {
        return Err("WinAuth 加密嵌套或解密大小超过限制".into());
    }
    budget.bytes = budget.bytes.checked_add(text.len()).ok_or(DECRYPT_ERROR)?;
    if budget.bytes > MAX_IMPORT_BYTES * (MAX_NESTING + 1) {
        return Err("WinAuth 累计解密大小超过限制".into());
    }
    let document =
        roxmltree::Document::parse(text).map_err(|_| "WinAuth XML 格式错误（不允许 DTD）")?;
    let mut result = Zeroizing::new(String::with_capacity(text.len()));
    let mut offset = 0;
    // Replace each outer encrypted node once; nested plaintext is expanded recursively.
    for node in document.descendants().filter(|node| {
        node.is_element() && protected(*node) && !node.ancestors().skip(1).any(protected)
    }) {
        budget.nodes += 1;
        if budget.nodes > MAX_ENCRYPTED_NODES {
            return Err("WinAuth 加密记录超过 1000 条限制".into());
        }
        let mode = node.attribute("encrypted").unwrap_or("");
        if mode.contains(['u', 'm']) {
            return Err(
                "WinAuth 文件绑定了原 Windows 用户或电脑，请在原软件解除本机保护后导出".into(),
            );
        }
        if mode.contains(['a', 'b']) {
            return Err("WinAuth 文件使用硬件密钥保护，请在原软件解除该保护后导出".into());
        }
        if mode != "y" || node.children().any(|n| n.is_element()) {
            return Err("不支持的 WinAuth 加密结构".into());
        }
        let name = node.tag_name().name();
        if ![
            "WinAuth",
            "winauth",
            "config",
            "data",
            "authenticatordata",
            "authenticator",
            "secretdata",
        ]
        .contains(&name)
        {
            return Err("不支持的 WinAuth 加密节点".into());
        }
        let password = password
            .filter(|p| !p.is_empty())
            .ok_or("这是加密备份，请输入导出时设置的密码")?;
        if password.len() > 4096 {
            return Err("导出密码过长".into());
        }
        let ciphertext = Zeroizing::new(
            node.text()
                .unwrap_or("")
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>(),
        );
        let plain = decrypt(&ciphertext, password, name == "secretdata")?;
        let replacement = if name == "secretdata" {
            // WinAuth v2 encrypts the secret bytes themselves; SecretData expects hex.
            let mut content = Zeroizing::new(String::from("<secretdata>"));
            use std::fmt::Write;
            for byte in plain.iter() {
                write!(content, "{byte:02X}").map_err(|_| DECRYPT_ERROR)?;
            }
            content.push_str("</secretdata>");
            content
        } else {
            let value = std::str::from_utf8(&plain).map_err(|_| DECRYPT_ERROR)?;
            let value = value.trim_start_matches('\u{feff}').trim();
            // A protected authenticator contains its complete original XML element.
            // Parse before insertion so malformed plaintext never changes outer structure.
            let expanded = expand(value, Some(password), depth + 1, budget)?;
            let document = roxmltree::Document::parse(&expanded).map_err(|_| DECRYPT_ERROR)?;
            // XmlWriter may include a UTF-8 declaration even for a protected
            // authenticator fragment. Only its root element belongs inside XML.
            Zeroizing::new(expanded[document.root_element().range()].to_owned())
        };
        let range = node.range();
        if result.len() + range.start - offset + replacement.len() > MAX_IMPORT_BYTES {
            return Err("WinAuth 解密大小超过 16 MiB 限制".into());
        }
        result.push_str(&text[offset..range.start]);
        result.push_str(&replacement);
        offset = range.end;
    }
    if result.len() + text.len() - offset > MAX_IMPORT_BYTES {
        return Err("WinAuth 解密大小超过 16 MiB 限制".into());
    }
    result.push_str(&text[offset..]);
    Ok(result)
}

fn decrypt(
    text: &str,
    password: &str,
    require_checksum: bool,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let bytes = Zeroizing::new(decode_hex(text).map_err(|_| DECRYPT_ERROR)?);
    // Old protected secretdata contains raw secret bytes, with no XML or MAC.
    // A wrong password passes ISO10126 padding with probability 8/256 and would
    // otherwise become a plausible OTP secret. Only accept a verified envelope.
    if require_checksum && !bytes.starts_with(b"WINAUTH3") {
        return Err("不支持的 WinAuth 加密结构".into());
    }
    let (expected, input) = if bytes.starts_with(b"WINAUTH3") {
        if bytes.len() < 8 + 8 + 32 + 16 {
            return Err(DECRYPT_ERROR.into());
        }
        (Some((&bytes[8..16], &bytes[16..48])), &bytes[48..])
    } else {
        (None, bytes.as_slice())
    };
    if input.len() < 16 || (input.len() - 8) % 8 != 0 {
        return Err(DECRYPT_ERROR.into());
    }
    // BeyondDimension/WinAuth derives 256 BYTES. Its BouncyCastle Blowfish engine
    // consumes exactly 18 * 4 bytes during P-array expansion; the remaining bytes
    // are unused. Deriving the identical 72-byte prefix avoids unnecessary work.
    // The bcrypt feature exposes the unbounded legacy key expansion (normal
    // Blowfish KeyInit rightly rejects this historical nonstandard key size).
    let mut key = Zeroizing::new([0u8; 72]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), &input[..8], 2000, &mut *key);
    let mut cipher = blowfish::Blowfish::bc_init_state();
    cipher.bc_expand_key(&*key);
    let mut plain = Zeroizing::new(input[8..].to_vec());
    for block in plain.chunks_exact_mut(8) {
        cipher.decrypt_block(GenericArray::from_mut_slice(block));
    }
    let padding = plain.last().copied().unwrap_or(0) as usize;
    // ISO10126 padding has random bytes and only the last byte is significant.
    if !(1..=8).contains(&padding) || padding > plain.len() {
        return Err(DECRYPT_ERROR.into());
    }
    let length = plain.len() - padding;
    // Zeroizing's final drop covers capacity, but explicitly wipe truncated bytes too.
    use zeroize::Zeroize;
    plain[length..].zeroize();
    plain.truncate(length);
    if let Some((salt, expected)) = expected {
        let mut digest = Sha256::new();
        digest.update(salt);
        digest.update(&*plain);
        let actual = digest.finalize();
        if actual
            .iter()
            .zip(expected)
            .fold(0u8, |a, (x, y)| a | (x ^ y))
            != 0
        {
            return Err(DECRYPT_ERROR.into());
        }
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::parse_import;

    const PASSWORD: &str = "fixture-password-秘密";
    const ROOT: &str = include_str!("fixtures/winauth-password.xml");
    const RECORD: &str = include_str!("fixtures/winauth-record-password.xml");
    const V2: &str = include_str!("fixtures/winauth-v2-password.xml");
    const V2_UNVERIFIED: &str = include_str!("fixtures/winauth-v2-unverified.xml");
    const DAT: &[u8] = include_bytes!("fixtures/watt-v1.dat.txt");

    #[test]
    fn independent_bouncycastle_exports_import_root_record_and_v2_protection() {
        for (fixture, name) in [(ROOT, "Fixture Ω"), (RECORD, "Per record"), (V2, "V2")] {
            let tokens = parse_import(fixture.as_bytes(), Some(PASSWORD), "fixture.xml").unwrap();
            assert_eq!(tokens.len(), 1);
            assert_eq!(tokens[0].name, name);
            assert_eq!(tokens[0].secret, b"1234567890");
            assert_eq!(tokens[0].kind, "totp");
            assert_eq!(tokens[0].period, 30);
            assert_eq!(tokens[0].digits, 6);
        }
    }

    #[test]
    fn missing_password_wrong_password_and_sha256_envelope_tampering_fail() {
        for fixture in [ROOT, RECORD, V2] {
            assert!(parse_import(fixture.as_bytes(), None, "fixture.xml").is_err());
            assert!(parse_import(fixture.as_bytes(), Some("wrong"), "fixture.xml").is_err());
        }
        // BouncyCastle independently confirms wrong-31 decrypts the unchecked
        // fixture to 11 random bytes with valid ISO10126 padding. Never accept it.
        for password in [PASSWORD, "wrong-31"] {
            assert!(parse_import(V2_UNVERIFIED.as_bytes(), Some(password), "fixture.xml").is_err());
        }
        let mut corrupted = ROOT.to_owned();
        let hash_start = corrupted.find("57494E4155544833").unwrap() + 32;
        let substitute = if &corrupted[hash_start..hash_start + 1] == "0" {
            "1"
        } else {
            "0"
        };
        corrupted.replace_range(hash_start..hash_start + 1, substitute);
        assert!(parse_import(corrupted.as_bytes(), Some(PASSWORD), "fixture.xml").is_err());
        for mode in ["yu", "ym", "a", "b", "unknown"] {
            let blocked = ROOT.replacen("encrypted=\"y\"", &format!("encrypted=\"{mode}\""), 1);
            assert!(parse_import(blocked.as_bytes(), Some(PASSWORD), "fixture.xml").is_err());
        }
    }

    #[test]
    fn independent_gzip_dat_imports_and_invalid_archives_fail() {
        let tokens = parse_import(DAT, None, "fixture.DAT").unwrap();
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].secret, b"1234567890");
        assert_eq!(tokens[0].name, "Fixture Ω");
        assert!(parse_import(b"invalid", None, "fixture.dat").is_err());
        let mut compressed = STANDARD.decode(DAT).unwrap();
        compressed.pop();
        assert!(dat(STANDARD.encode(&compressed).as_bytes()).is_err());
        compressed = STANDARD.decode(DAT).unwrap();
        compressed.extend_from_slice(b"trailing");
        assert!(dat(STANDARD.encode(&compressed).as_bytes()).is_err());
    }

    #[test]
    fn gzip_bombs_dtd_and_excessive_protected_nodes_are_bounded() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder
            .write_all(&vec![b' '; MAX_IMPORT_BYTES + 1])
            .unwrap();
        let data = STANDARD.encode(encoder.finish().unwrap());
        assert!(dat(data.as_bytes()).unwrap_err().contains("16 MiB"));
        assert!(xml("<!DOCTYPE w [<!ENTITY a 'b'>]><w>&a;</w>", None).is_err());
        // Exercise the node bound without spending 1001 password derivations.
        let mut budget = Budget {
            nodes: MAX_ENCRYPTED_NODES,
            bytes: 0,
        };
        assert!(expand(ROOT, Some(PASSWORD), 0, &mut budget)
            .unwrap_err()
            .contains("1000"));
        assert!(expand(
            ROOT,
            Some(PASSWORD),
            MAX_NESTING + 1,
            &mut Budget { nodes: 0, bytes: 0 }
        )
        .is_err());
    }
}
