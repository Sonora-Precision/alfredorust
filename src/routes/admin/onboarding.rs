//! Tenant onboarding readiness.
//!
//! Single source of truth for "is this company ready to use". Both the SolidJS
//! setup wizard and the `spcli onboarding status` command consume this endpoint,
//! so the checklist never drifts between UI and CLI.
//!
//! A company created via the runtime API starts empty (the concept-status
//! auto-seed only runs on the boot seed path, not on `create_company`), so this
//! covers every step a fresh tenant needs before the app is usable.

use std::sync::Arc;

use axum::{Json, extract::State, http::StatusCode};
use serde::Serialize;

use crate::{
    models::FlowType,
    session::SessionUser,
    state::{
        AppState, list_accounts, list_categories, list_concept_statuses, list_contacts,
        list_sat_configs, list_users,
    },
};

/// One checklist item. `required` steps gate `ready`; the rest are recommended
/// or optional (they only unlock extra features).
#[derive(Serialize)]
pub struct OnboardingStep {
    /// Stable machine key (used by the CLI/skill and the wizard to branch).
    pub key: &'static str,
    /// Human label (Spanish, matches the UI).
    pub label: &'static str,
    /// Whether this step blocks `ready`.
    pub required: bool,
    /// Whether the step is satisfied.
    pub done: bool,
    /// How many matching records exist (for display).
    pub count: u64,
    /// One-line status detail.
    pub detail: String,
    /// What completing this step unlocks (empty for the base company step).
    pub unlocks: &'static str,
    /// SPA route whose create form fills this step.
    pub route: &'static str,
    /// Call-to-action label for the wizard button.
    pub cta: &'static str,
}

/// Whole-tenant readiness snapshot.
#[derive(Serialize)]
pub struct OnboardingStatus {
    /// True once every required step is done.
    pub ready: bool,
    pub required_done: usize,
    pub required_total: usize,
    pub steps: Vec<OnboardingStep>,
}

/// `GET /api/onboarding/status` — admin-only readiness for the active company.
#[utoipa::path(
    get,
    path = "/api/onboarding/status",
    tag = "admin",
    responses(
        (status = 200, description = "Onboarding readiness for the active company"),
        (status = 401, description = "Not authenticated"),
        (status = 403, description = "Forbidden")
    ),
    security(("session" = []))
)]
pub async fn onboarding_status_api(
    session_user: SessionUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<OnboardingStatus>, StatusCode> {
    if !session_user.is_admin() {
        return Err(StatusCode::FORBIDDEN);
    }
    let company_id = session_user.active_company_id().clone();
    let company_name = session_user.user().company_name.clone();

    let ise = |_| StatusCode::INTERNAL_SERVER_ERROR;

    // list_accounts/categories/contacts/users return every tenant's rows, so we
    // filter by the active company here (same pattern as the *_data_api handlers).
    let account_count = list_accounts(&state)
        .await
        .map_err(ise)?
        .iter()
        .filter(|a| a.company_id == company_id)
        .count() as u64;

    let categories = list_categories(&state).await.map_err(ise)?;
    let income = categories
        .iter()
        .filter(|c| c.company_id == company_id && matches!(c.flow_type, FlowType::Income))
        .count();
    let expense = categories
        .iter()
        .filter(|c| c.company_id == company_id && matches!(c.flow_type, FlowType::Expense))
        .count();

    let contact_count = list_contacts(&state)
        .await
        .map_err(ise)?
        .iter()
        .filter(|c| c.company_id == company_id)
        .count() as u64;

    // These two are already company-scoped at the state layer.
    let status_count = list_concept_statuses(&state, &company_id)
        .await
        .map_err(ise)?
        .len() as u64;
    let sat_count = list_sat_configs(&state, &company_id).await.map_err(ise)?.len() as u64;

    let user_count = list_users(&state)
        .await
        .map_err(ise)?
        .iter()
        .filter(|u| u.company_ids.iter().any(|c| c == &company_id))
        .count() as u64;

    let categories_done = income >= 1 && expense >= 1;

    let steps = vec![
        OnboardingStep {
            key: "company",
            label: "Empresa",
            required: true,
            done: true,
            count: 1,
            detail: format!("{company_name} — nombre y moneda listos"),
            unlocks: "",
            route: "/companies",
            cta: "Editar empresa",
        },
        OnboardingStep {
            key: "accounts",
            label: "Cuentas",
            required: true,
            done: account_count >= 1,
            count: account_count,
            detail: if account_count >= 1 {
                format!("{account_count} cuenta(s)")
            } else {
                "Agrega al menos una cuenta (banco/efectivo)".to_string()
            },
            unlocks: "transacciones y planes",
            route: "/accounts",
            cta: "Agregar cuenta",
        },
        OnboardingStep {
            key: "categories",
            label: "Categorías",
            required: true,
            done: categories_done,
            count: (income + expense) as u64,
            detail: format!("{income} de ingreso, {expense} de gasto (se necesita ≥1 de cada)"),
            unlocks: "transacciones y planes",
            route: "/categories",
            cta: "Agregar categoría",
        },
        OnboardingStep {
            key: "concept_statuses",
            label: "Estados de concepto",
            required: true,
            done: status_count >= 1,
            count: status_count,
            detail: if status_count >= 1 {
                format!("{status_count} estado(s)")
            } else {
                "Define el flujo de estados (inicial → terminal)".to_string()
            },
            unlocks: "proyectos y captura de tiempo",
            route: "/concept-statuses",
            cta: "Configurar estados",
        },
        OnboardingStep {
            key: "contacts",
            label: "Contactos",
            required: false,
            done: contact_count >= 1,
            count: contact_count,
            detail: if contact_count >= 1 {
                format!("{contact_count} contacto(s)")
            } else {
                "Agrega clientes/proveedores".to_string()
            },
            unlocks: "conciliación de CFDI y planes",
            route: "/contacts",
            cta: "Agregar contacto",
        },
        OnboardingStep {
            key: "sat_config",
            label: "Configuración SAT",
            required: false,
            done: sat_count >= 1,
            count: sat_count,
            detail: if sat_count >= 1 {
                format!("{sat_count} FIEL configurada(s)")
            } else {
                "Sube tu e.firma (.cer + .key + contraseña)".to_string()
            },
            unlocks: "descarga automática de CFDI",
            route: "/sat-configs",
            cta: "Subir e.firma",
        },
        OnboardingStep {
            key: "users",
            label: "Equipo",
            required: false,
            done: user_count >= 2,
            count: user_count,
            detail: if user_count >= 2 {
                format!("{user_count} usuarios")
            } else {
                "Invita a tu equipo (opcional)".to_string()
            },
            unlocks: "colaboración",
            route: "/users",
            cta: "Invitar usuario",
        },
    ];

    let required_total = steps.iter().filter(|s| s.required).count();
    let required_done = steps.iter().filter(|s| s.required && s.done).count();
    let ready = required_done == required_total;

    Ok(Json(OnboardingStatus {
        ready,
        required_done,
        required_total,
        steps,
    }))
}
