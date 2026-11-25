use crate::{models::Token, vault::VaultData};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use zeroize::Zeroize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    index: usize,
    name: String,
    issuer: String,
    kind: String,
    existing_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    id: String,
    name: String,
    issuer: String,
    group: Option<String>,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Replacement {
    pub source_index: usize,
    pub target_id: String,
}

fn supported(token: &Token) -> bool {
    matches!(token.kind.as_str(), "totp" | "hotp")
}

pub(crate) fn choices(incoming: &[Token], existing: &[Token]) -> (Vec<Source>, Vec<Target>) {
    let targets: Vec<_> = existing
        .iter()
        .filter(|t| supported(t) && !t.hotp_read_only)
        .map(|t| Target {
            id: t.id.clone(),
            name: t.name.clone(),
            issuer: t.issuer.clone(),
            group: t.group.clone(),
            kind: t.kind.clone(),
        })
        .collect();
    let mut seen = HashSet::new();
    let sources = incoming
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            targets.iter().any(|target| target.kind == t.kind)
                && seen.insert((t.kind.as_str(), t.secret.as_slice()))
        })
        .map(|(index, t)| Source {
            index,
            name: t.name.clone(),
            issuer: t.issuer.clone(),
            kind: t.kind.clone(),
            existing_id: existing
                .iter()
                .find(|old| old.kind == t.kind && old.secret == t.secret)
                .map(|old| old.id.clone()),
        })
        .collect();
    (sources, targets)
}

/// Replace only the selected records. The caller commits the entire plan in a vault transaction.
pub(crate) fn apply(
    data: &mut VaultData,
    incoming: &[Token],
    replacements: &[Replacement],
) -> Result<usize, String> {
    let invalid = || "请选择不同且仍存在的同类型令牌进行替换".to_owned();
    let mut used_keys = HashSet::new();
    let mut used_targets = HashSet::new();
    let mut plan = Vec::new();
    for choice in replacements {
        let source = incoming.get(choice.source_index).ok_or_else(invalid)?;
        let target = data
            .tokens
            .iter()
            .find(|token| token.id == choice.target_id)
            .ok_or_else(invalid)?;
        if !supported(source)
            || source.kind != target.kind
            || !used_keys.insert((source.kind.as_str(), source.secret.as_slice()))
            || !used_targets.insert(target.id.clone())
        {
            return Err(invalid());
        }
        let duplicates: Vec<_> = data
            .tokens
            .iter()
            .filter(|token| {
                token.id != target.id && token.kind == source.kind && token.secret == source.secret
            })
            .collect();
        if duplicates.len() > 1 {
            return Err("导入密钥对应多个已有令牌，请先处理重复项".into());
        }
        let duplicate = duplicates.first().copied();
        if target.hotp_read_only || duplicate.is_some_and(|token| token.hotp_read_only) {
            return Err("此 HOTP 的主设备为其他设备，请先切换主设备".into());
        }
        let counter = if target.secret == source.secret {
            target.counter
        } else {
            0
        };
        let counter = source
            .counter
            .max(counter)
            .max(duplicate.map_or(0, |t| t.counter));
        plan.push((
            source,
            target.id.clone(),
            duplicate.map(|t| t.id.clone()),
            counter,
        ));
    }
    if plan.iter().any(|(_, _, duplicate, _)| {
        duplicate
            .as_ref()
            .is_some_and(|id| used_targets.contains(id))
    }) {
        return Err(invalid());
    }

    for (source, target_id, duplicate, counter) in plan {
        if let Some(id) = duplicate {
            crate::token_commands::delete(data, &[id])?;
        }
        let target = data
            .tokens
            .iter_mut()
            .find(|t| t.id == target_id)
            .ok_or_else(invalid)?;
        if target.secret != source.secret {
            let mut old = target.clone();
            old.id = uuid::Uuid::new_v4().to_string();
            data.trash.push(crate::vault::TrashEntry {
                token: old,
                deleted_at: crate::models::now(),
            });
            target.secret.zeroize();
            target.secret.clone_from(&source.secret);
        }
        target.algorithm.clone_from(&source.algorithm);
        target.digits = source.digits;
        target.period = source.period;
        target.counter = counter;
        target.validate()?;
    }
    Ok(replacements.len())
}
