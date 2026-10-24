/// Matches the existing local-time cron search, including day/hour skips.
pub fn next_run(expression: &str, from: i64) -> Result<Option<i64>, String> {
    let cron = crate::modules::routines::domain::Cron::parse(expression)?;
    let seconds = from.div_euclid(1000);
    let mut date = unsafe { std::mem::zeroed::<libc::tm>() };
    if unsafe { libc::localtime_r(&seconds, &mut date) }.is_null() {
        return Err("Invalid schedule timestamp".into());
    }
    date.tm_sec = 0;
    date.tm_min += 1;
    let limit = from.saturating_add(400 * 86_400_000);
    loop {
        let timestamp = normalize_local(&mut date);
        if timestamp == -1 {
            return Err("Invalid schedule timestamp".into());
        }
        let ms = (timestamp as i64).saturating_mul(1000);
        if ms >= limit {
            return Ok(None);
        }
        if !cron.day_matches(
            date.tm_mon as u32 + 1,
            date.tm_mday as u32,
            date.tm_wday as u32,
        ) {
            date.tm_mday += 1;
            date.tm_hour = 0;
            date.tm_min = 0;
        } else if !cron.hour_matches(date.tm_hour as u32) {
            date.tm_hour += 1;
            date.tm_min = 0;
        } else if !cron.minute_matches(date.tm_min as u32) {
            date.tm_min += 1;
        } else {
            return Ok(Some(ms));
        }
    }
}

// ECMAScript Date setters choose the earlier instant in a fold and move forward
// across a gap. libc's automatic DST choice is platform-dependent, so compare
// explicit candidates against the normalized wall-clock fields.
fn normalize_local(date: &mut libc::tm) -> libc::time_t {
    let mut wall = *date;
    let wanted = unsafe { libc::timegm(&mut wall) };
    let mut exact = Vec::new();
    let mut forward = Vec::new();
    for dst in [-1, 0, 1] {
        let mut candidate = wall;
        candidate.tm_isdst = dst;
        let instant = unsafe { libc::mktime(&mut candidate) };
        let mut local = candidate;
        let actual = unsafe { libc::timegm(&mut local) };
        if actual == wanted {
            exact.push((instant, candidate));
        } else if actual > wanted {
            forward.push((actual - wanted, instant, candidate));
        }
    }
    if let Some((instant, normalized)) = exact.into_iter().min_by_key(|entry| entry.0) {
        *date = normalized;
        instant
    } else if let Some((_, instant, normalized)) =
        forward.into_iter().min_by_key(|entry| (entry.0, entry.1))
    {
        *date = normalized;
        instant
    } else {
        -1
    }
}
