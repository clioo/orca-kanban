//! Cron schedules for columns (UTC), evaluated with `croner` over plain Unix
//! seconds. Ported from Drogon's automation scheduler.
use std::cmp::Ordering;
use std::str::FromStr;

use croner::time::{CivilDate, CivilDateTime, CivilTime, Resolution, Weekday};
use croner::{Cron, CronDateTime};

pub const CRON_EXPRESSION_MAX_BYTES: usize = 256;

/// A Unix timestamp in whole seconds, viewed as UTC. Implements
/// [`CronDateTime`] so cron evaluation needs no date/time crate beyond
/// `croner` itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct UnixUtc(i64);

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y } as i32, m, d)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_of(unix_secs: i64) -> CivilDateTime {
    let days = unix_secs.div_euclid(86_400);
    let rem = unix_secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    CivilDateTime::new(
        CivilDate::from_parts_unchecked(y, mo, d),
        CivilTime::from_parts_unchecked(
            (rem / 3600) as u32,
            ((rem % 3600) / 60) as u32,
            (rem % 60) as u32,
        ),
    )
}

impl CronDateTime for UnixUtc {
    fn to_civil(&self) -> CivilDateTime {
        civil_of(self.0)
    }

    fn civil_weekday(&self) -> Weekday {
        // 1970-01-01 was a Thursday (4 days after Sunday).
        Weekday::from_days_from_sunday(
            self.0
                .div_euclid(86_400)
                .rem_euclid(7)
                .wrapping_add(4)
                .rem_euclid(7) as u32,
        )
    }

    fn resolve_civil(
        &self,
        civil: CivilDateTime,
    ) -> Result<Resolution<Self>, croner::errors::CronError> {
        use croner::errors::CronError;
        let date = CivilDate::from_ymd_opt(civil.year(), civil.month(), civil.day())
            .ok_or(CronError::InvalidDate)?;
        let _ = date;
        let time = CivilTime::from_hms_opt(civil.hour(), civil.minute(), civil.second())
            .ok_or(CronError::InvalidTime)?;
        let _ = time;
        let secs = days_from_civil(civil.year(), civil.month(), civil.day()) * 86_400
            + i64::from(civil.hour()) * 3600
            + i64::from(civil.minute()) * 60
            + i64::from(civil.second());
        Ok(Resolution::Single(UnixUtc(secs)))
    }

    fn checked_add_seconds(&self, seconds: i64) -> Option<Self> {
        self.0.checked_add(seconds).map(UnixUtc)
    }

    fn cmp_instant(&self, other: &Self) -> Ordering {
        self.0.cmp(&other.0)
    }
}

/// Strict cron validation shared by `create`/`update` and the tick: trims,
/// byte-caps, then parses. Returns the canonical trimmed expression.
pub fn validate_cron(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("cron expression must not be empty".to_string());
    }
    if trimmed.len() > CRON_EXPRESSION_MAX_BYTES {
        return Err(format!(
            "cron expression must be at most {CRON_EXPRESSION_MAX_BYTES} bytes"
        ));
    }
    if trimmed.bytes().any(|b| b.is_ascii_control()) {
        return Err("cron expression must not contain control characters".to_string());
    }
    Cron::from_str(trimmed).map_err(|e| format!("invalid cron expression: {e}"))?;
    Ok(trimmed.to_string())
}

/// True when `rrule` parses as a cron expression (as opposed to a legacy
/// `FREQ=...` RRULE written by the Bot flow, which the tick ignores).
pub fn is_cron_schedule(rrule: &str) -> bool {
    validate_cron(rrule).is_ok()
}

/// Next cron fire strictly after `after_ms` (millisecond epoch), as
/// millisecond epoch. `None` when the expression never fires again or the
/// search fails -- callers keep the stored `next_run_at` in that case,
/// never a fabricated time.
pub fn next_fire_ms(cron_expr: &str, after_ms: f64) -> Option<i64> {
    let cron = Cron::from_str(cron_expr.trim()).ok()?;
    let after_secs = (after_ms / 1000.0).floor() as i64;
    let next = cron
        .find_next_occurrence(&UnixUtc(after_secs), false)
        .ok()?;
    next.0.checked_mul(1000)
}
