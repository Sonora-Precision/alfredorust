//! Removes money from free text before it reaches users who cannot see money. Shops type
//! quoted prices into part descriptions and notes ("Fixture pallet — PU cotización $455");
//! the structured money fields are already redacted, this covers what people write.

/// Separators people use between the label and the price in a description.
const SEPARATORS: [&str; 5] = [" — ", " – ", " - ", " · ", " | "];

/// Words that mark a segment as a price even without a "$" ("precio 455 MXN").
const MONEY_WORDS: [&str; 7] = ["cotiz", "precio", "p.u.", "pu ", "costo", "mxn", "usd"];

fn has_amount(segment: &str) -> bool {
    segment.chars().any(|c| c.is_ascii_digit())
}

fn is_money_segment(segment: &str) -> bool {
    let lower = segment.to_lowercase();
    if lower.contains('$') {
        return true;
    }
    has_amount(&lower) && MONEY_WORDS.iter().any(|w| lower.contains(w))
}

/// Drops every "$1,560"-style amount from a piece of text.
fn drop_amounts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            while chars.peek().is_some_and(|n| *n == ' ') {
                chars.next();
            }
            while chars
                .peek()
                .is_some_and(|n| n.is_ascii_digit() || *n == ',' || *n == '.')
            {
                chars.next();
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Per line: segments between separators that carry a price are removed; any amount left
/// is dropped. Lines that end up empty disappear.
pub fn strip_money(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let mut segments: Vec<&str> = vec![line];
            for sep in SEPARATORS {
                segments = segments.iter().flat_map(|s| s.split(sep)).collect();
            }
            let total = segments.len();
            let kept: Vec<&str> = segments
                .into_iter()
                .filter(|s| !is_money_segment(s))
                .collect();
            // Nothing priced: keep the line exactly as written (its own separators).
            if kept.len() == total {
                return drop_amounts(line).trim_end().to_string();
            }
            drop_amounts(&kept.join(" — ")).trim().to_string()
        })
        .filter(|l| !l.is_empty())
        .collect();
    lines.join("\n")
}

/// `strip_money` for an optional field; `None` when nothing is left.
pub fn strip_money_opt(text: Option<String>) -> Option<String> {
    text.map(|t| strip_money(&t)).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_sp_descriptions_keep_the_label() {
        assert_eq!(
            strip_money("Fixture pallet Vulcan/Doublemint — PU cotización $455"),
            "Fixture pallet Vulcan/Doublemint"
        );
        assert_eq!(
            strip_money("Fixture power connector — PU cotización $1,560"),
            "Fixture power connector"
        );
    }

    #[test]
    fn price_only_text_disappears() {
        assert_eq!(strip_money_opt(Some("PU cotización $585".into())), None);
        assert_eq!(strip_money_opt(Some("$1,950.00".into())), None);
    }

    #[test]
    fn prices_without_a_dollar_sign() {
        assert_eq!(strip_money("Placa base · precio 455 MXN"), "Placa base");
    }

    #[test]
    fn technical_text_is_untouched() {
        let notes = "Vulcan 2×20=40 · Material: 4140 · Stock 1/2\" x 1.125\" x 6.375\"\n⚠ Cant. por confirmar";
        assert_eq!(strip_money(notes), notes);
        assert_eq!(strip_money("Rosca M5 - 4 setups"), "Rosca M5 - 4 setups");
    }

    #[test]
    fn a_line_that_mentions_a_price_goes_whole() {
        assert_eq!(
            strip_money_opt(Some("Se cotizó aparte por $300 el tratamiento".into())),
            None
        );
    }

    #[test]
    fn only_price_lines_go() {
        assert_eq!(
            strip_money("Material 4140\nPU cotización $455\nSetup en VF-3"),
            "Material 4140\nSetup en VF-3"
        );
    }
}
