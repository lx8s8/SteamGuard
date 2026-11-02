//! Authenticated local envelope. The Windows Hello signature is only ever an
//! in-memory KDF input. It must not be saved beside this ciphertext or sent out.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u8,
    pub challenge: [u8; 32],
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}
const ERROR: &str = "设备密钥不可用，请使用主密码解锁";
pub fn random_challenge() -> [u8; 32] {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
}
pub fn signing_challenge(namespace: &str, challenge: &[u8; 32]) -> Vec<u8> {
    let mut value = b"SteamGuard device-only Hello wrapping v1\0".to_vec();
    value.extend_from_slice(namespace.as_bytes());
    value.push(0);
    value.extend_from_slice(challenge);
    value
}
pub fn derive_key(signature: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    // Current Hello RSA keys produce a 256-byte signature. Keep the bound
    // explicit; unexpected provider/algorithm results must never enroll.
    if signature.len() != 256 {
        return Err(ERROR.into());
    }
    let mut digest = Sha256::new();
    digest.update(b"SteamGuard device-only AEAD key v1\0");
    digest.update(signature);
    Ok(Zeroizing::new(digest.finalize().into()))
}
pub fn seal(
    namespace: &str,
    challenge: [u8; 32],
    key: &[u8; 32],
    data: &str,
) -> Result<Envelope, String> {
    super::validate_data(data)?;
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = signing_challenge(namespace, &challenge);
    let ciphertext = Aes256Gcm::new_from_slice(key)
        .map_err(|_| ERROR)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: data.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| ERROR)?;
    Ok(Envelope {
        version: 1,
        challenge,
        nonce,
        ciphertext,
    })
}
pub fn open(namespace: &str, envelope: &Envelope, key: &[u8; 32]) -> Result<String, String> {
    if envelope.version != 1 || !(17..=16400).contains(&envelope.ciphertext.len()) {
        return Err(ERROR.into());
    }
    let aad = signing_challenge(namespace, &envelope.challenge);
    let bytes = Zeroizing::new(
        Aes256Gcm::new_from_slice(key)
            .map_err(|_| ERROR)?
            .decrypt(
                Nonce::from_slice(&envelope.nonce),
                Payload {
                    msg: &envelope.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| ERROR)?,
    );
    std::str::from_utf8(&bytes)
        .map(str::to_owned)
        .map_err(|_| ERROR.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hello_envelope_authenticates_ciphertext_namespace_challenge_and_key() {
        let key = [7; 32];
        let namespace = "com.example.authenticator.qa";
        let mut envelope = seal(namespace, [4; 32], &key, "synthetic device credential").unwrap();
        assert_eq!(
            open(namespace, &envelope, &key).unwrap(),
            "synthetic device credential"
        );
        assert!(open("com.example.authenticator", &envelope, &key).is_err());
        assert!(open(namespace, &envelope, &[9; 32]).is_err());
        envelope.challenge[0] ^= 1;
        assert!(open(namespace, &envelope, &key).is_err());
        envelope.challenge[0] ^= 1;
        envelope.ciphertext[0] ^= 1;
        assert!(open(namespace, &envelope, &key).is_err());
    }
    #[test]
    fn version_and_malformed_envelopes_fail_closed() {
        let mut envelope =
            seal("com.example.authenticator", [4; 32], &[7; 32], "synthetic").unwrap();
        envelope.version = 2;
        assert!(open("com.example.authenticator", &envelope, &[7; 32]).is_err());
        assert!(serde_json::from_str::<Envelope>(
            r#"{"version":1,"challenge":[],"nonce":[],"ciphertext":[]}"#
        )
        .is_err());
        assert!(derive_key(&[0; 255]).is_err());
        assert!(super::super::validate_slot("../../credentials").is_err());
        assert!(super::super::validate_data("").is_err());
        assert!(super::super::validate_data(&"x".repeat(16385)).is_err());
    }
    #[test]
    fn nonces_are_fresh_and_no_signature_is_serialized() {
        let a = seal(
            "com.example.authenticator",
            random_challenge(),
            &[1; 32],
            "synthetic",
        )
        .unwrap();
        let b = seal(
            "com.example.authenticator",
            random_challenge(),
            &[1; 32],
            "synthetic",
        )
        .unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.challenge, b.challenge);
        assert_ne!(
            signing_challenge("a", &a.challenge),
            signing_challenge("a\0b", &a.challenge)
        );
        let json = serde_json::to_string(&a).unwrap();
        assert!(!json.contains("signature"));
        assert!(!json.contains("synthetic"));
    }
}
