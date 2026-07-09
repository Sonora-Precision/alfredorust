---
name: onboarding
description: >-
  Guided first-run setup for a new tenant on the Sonora Precision / alfredodev
  financial platform. Use this when a user has just created their company and
  needs help getting it "ready to operate", or asks to be onboarded / walked
  through setup / "configurar mi empresa" / "qué me falta para empezar". It
  interviews the user for the minimum data (accounts, categories, concept
  statuses, contacts, SAT e.firma, team users), fills it via `spcli`, and reports
  exactly what is still missing until the tenant is ready. Backed by the same
  readiness endpoint (`spcli onboarding status`) the in-app setup wizard uses, so
  the CLI and UI never disagree.
---

# onboarding — get a new tenant ready to operate

This skill drives the tenant setup interview end to end. It reads the readiness
checklist from the server, asks the user only for what is missing, fills it with
`spcli`, and re-checks until the company is ready. The checklist is defined
once server-side (`GET /api/onboarding/status`, `src/routes/admin/onboarding.rs`)
and consumed identically by the in-app **Configuración inicial** wizard and by
`spcli onboarding status` — never hard-code a different checklist here.

> Prerequisite: `spcli` is configured and logged in (see the **spcli** skill).
> If `spcli --json status` reports `not_authenticated`, run the spcli login flow
> first, then return here. All commands must target the user's company — confirm
> with `spcli --json company list` and `spcli company use <slug>` if needed.

## The readiness checklist

`spcli --json onboarding status` returns:

```json
{ "ready": false, "required_done": 2, "required_total": 3,
  "steps": [ { "key": "...", "label": "...", "required": true,
              "done": false, "count": 0, "detail": "...",
              "unlocks": "...", "route": "...", "cta": "..." } ] }
```

Steps, in order, with the `spcli` command that satisfies each. **Required** steps
gate `ready`; the rest unlock extra features and are optional.

| key | required | Satisfy with |
|-----|----------|--------------|
| `company` | ✓ (already exists) | nothing — the company exists; offer `spcli admin companies update <id>` only if they want to change name/currency |
| `accounts` | ✓ | `spcli finance accounts create --name <NAME> --account-type <bank\|cash\|credit_card\|investment\|other> --currency MXN` |
| `categories` | ✓ | needs **≥1 income AND ≥1 expense**: `spcli finance categories create --name <NAME> --flow-type <income\|expense>` |
| `concept_statuses` | ✓ | seed the standard flow (see below) |
| `contacts` | ✗ | `spcli finance contacts create --name <NAME> --contact-type <customer\|supplier\|service\|other> --rfc <RFC?>` |
| `sat_config` | ✗ | `SAT_KEY_PASSWORD=… spcli sat configs upload --rfc <RFC> --cer-file <cert.cer> --key-file <private.key> --key-password-env SAT_KEY_PASSWORD --label <LABEL>` |
| `users` | ✗ | `spcli admin users create --email <USERNAME> --company-id <ID> --role <staff\|admin> --permission <perm>` |

## How to run the interview

0. **Greet and set the tone.** Open warmly and in the user's language (Spanish by
   default here): introduce what you're about to do and that it's guided, e.g.
   *"¡Vamos a dejar tu empresa lista para operar! Te hago unas preguntas rápidas y
   la voy configurando contigo, paso a paso."* Keep it hand-in-hand: explain each
   step in one line before asking, do one thing at a time, and confirm each result
   before moving on. Never dump the whole questionnaire at once.

1. **Read state first.** Run `spcli --json onboarding status`. Print a short
   summary: `required_done/required_total`, and the list of steps with `[x]/[ ]`,
   so the user sees where they stand. If `ready` is already true, tell them
   they're set and only offer the optional steps.

2. **Work the required steps in order** (`accounts` → `categories` →
   `concept_statuses`). For each `done: false` required step, ask the user the
   minimum questions, then run the create command. Ask conversationally, one
   step at a time — do not dump every question at once. Confirm each creation by
   echoing the JSON `id` returned.

   - **accounts:** ask for at least one account — its name, type (bank / cash /
     credit card / investment / other), and currency (default MXN). Offer to add
     more.
   - **categories:** the app needs at least one **income** and one **expense**
     category. Ask for a few of each (e.g. income: "Ventas"; expense: "Nómina",
     "Materiales"). Create them one per command. Re-check that both flows exist.
   - **concept_statuses:** offer the standard shop-floor flow as a one-shot. If
     they accept, create these 7 in order (positions 0–6):

     ```bash
     spcli --json projects statuses create --name "Pedido"      --position 0 --color slate  --initial
     spcli --json projects statuses create --name "Ingeniería"  --position 1 --color sky
     spcli --json projects statuses create --name "CNC"         --position 2 --color amber
     spcli --json projects statuses create --name "Calidad"     --position 3 --color violet
     spcli --json projects statuses create --name "Entrega"     --position 4 --color emerald
     spcli --json projects statuses create --name "Terminado"   --position 5 --color green  --terminal
     spcli --json projects statuses create --name "Cancelado"   --position 6 --color rose   --cancelled
     ```

     Exactly one `--initial` and one `--terminal` (and they must differ). If they
     want a custom flow instead, collect their status names in order and map the
     first to `--initial`, the last non-cancelled to `--terminal`, and any
     "cancelled" state to `--cancelled`.

3. **Then offer the optional steps** (`contacts`, `sat_config`, `users`). Make
   clear each is optional and say what it unlocks (contacts → CFDI matching &
   plans; sat_config → automatic CFDI download; users → team access).

   - **sat_config** needs real files on disk (`.cer` + `.key`) and the private-key
     password. Never put the password on the command line or in the transcript —
     read it from an env var: `SAT_KEY_PASSWORD=… spcli sat configs upload …`.
     If the user can't provide the files now, skip it and note CFDI download stays
     locked until they do.
   - **users:** get the active company id from `spcli --json company list`
     (the selected entry). The new user's TOTP secret is generated server-side and
     never printed — tell the user to open **Usuarios** in the web app to scan the
     new person's QR.

4. **Re-check and report.** After each round of changes, run
   `spcli --json onboarding status` again. When `ready` flips to `true`, tell the
   user their company is ready to operate and list which optional steps remain
   (with what each unlocks). Always end by stating precisely what is still
   missing, if anything — that closing "what's left" report is the point of this
   skill.

## Guardrails

- **Idempotency:** always read `onboarding status` before creating; never
  recreate a step that is already `done` unless the user explicitly asks for more.
- **One tenant:** confirm the active company before any create. If the user
  administers several, ask which one to onboard and `spcli company use <slug>`.
- **Secrets:** SAT key passwords and TOTP secrets go through env vars only, never
  inline, never echoed back.
- **Errors:** `spcli` prints structured JSON errors to stderr (`validation_error`,
  `forbidden`, …). Surface the `message`, fix the input, and retry — don't loop
  blindly.
- The in-app equivalent is the **Configuración inicial** wizard (`/onboarding`,
  admin only) with a nudge banner on the dashboard until the tenant is ready.
  Mention it if the user prefers a UI.
