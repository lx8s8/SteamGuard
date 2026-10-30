use crate::models::Token;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Sha256, Sha512};

pub fn code(token: &Token, timestamp: u64) -> Result<String, String> {
    token.validate()?;
    let counter = if token.kind == "hotp" {
        token.counter
    } else {
        timestamp / token.period
    };
    let msg = counter.to_be_bytes();
    let hash = match token.algorithm.as_str() {
        "SHA256" => {
            let mut m = Hmac::<Sha256>::new_from_slice(&token.secret).map_err(|_| "HMAC error")?;
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }
        "SHA512" => {
            let mut m = Hmac::<Sha512>::new_from_slice(&token.secret).map_err(|_| "HMAC error")?;
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }
        _ => {
            let mut m = Hmac::<Sha1>::new_from_slice(&token.secret).map_err(|_| "HMAC error")?;
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }
    };
    let offset = (hash[hash.len() - 1] & 15) as usize;
    let mut value = u32::from_be_bytes(
        hash[offset..offset + 4]
            .try_into()
            .map_err(|_| "Invalid HMAC")?,
    ) & 0x7fff_ffff;
    if token.kind == "steam" {
        let chars = b"23456789BCDFGHJKMNPQRTVWXY";
        let mut result = String::with_capacity(5);
        for _ in 0..5 {
            result.push(chars[(value % 26) as usize] as char);
            value /= 26;
        }
        Ok(result)
    } else {
        let value = u64::from(value) % 10u64.pow(token.digits);
        Ok(format!("{:0width$}", value, width = token.digits as usize))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc4226_vectors() {
        let mut t = Token::new(
            "RFC".into(),
            "hotp".into(),
            b"12345678901234567890".to_vec(),
        );
        for (i, expected) in [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ]
        .iter()
        .enumerate()
        {
            t.counter = i as u64;
            assert_eq!(&code(&t, 0).unwrap(), expected);
        }
    }
    #[test]
    fn rfc6238_all_algorithms() {
        for (alg, secret, expected) in [
            ("SHA1", b"12345678901234567890".as_slice(), "94287082"),
            (
                "SHA256",
                b"12345678901234567890123456789012".as_slice(),
                "46119246",
            ),
            (
                "SHA512",
                b"1234567890123456789012345678901234567890123456789012345678901234".as_slice(),
                "90693936",
            ),
        ] {
            let mut t = Token::new("RFC".into(), "totp".into(), secret.to_vec());
            t.algorithm = alg.into();
            t.digits = 8;
            assert_eq!(code(&t, 59).unwrap(), expected);
        }
    }
}
