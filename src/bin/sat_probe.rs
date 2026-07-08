use std::{env, path::PathBuf};

use alfredodev::{
    sat::{CfdiDownloadRequest, DownloadType, RequestType, download_cfdis},
    state::{get_sat_config, init_state},
};
use bson::oid::ObjectId;
use chrono::Utc;
use dotenvy::dotenv;
use futures::TryStreamExt;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok();

    let args = env::args().collect::<Vec<_>>();
    let state = init_state().await?;

    if args.get(1).map(String::as_str) == Some("list") {
        let mut cursor = state.sat_configs.find(bson::doc! {}).await?;
        while let Some(cfg) = cursor.try_next().await? {
            println!(
                "company_id={} sat_config_id={} rfc={} label={}",
                cfg.company_id,
                cfg.id.map(|id| id.to_hex()).unwrap_or_default(),
                cfg.rfc,
                cfg.label.unwrap_or_default()
            );
        }
        return Ok(());
    }

    if args.len() < 5 {
        eprintln!(
            "Usage:\n  {} list\n  {} run <sat_config_id> <start YYYY-MM-DD> <end YYYY-MM-DD> [issued|received] [max_attempts] [poll_seconds]",
            args[0], args[0]
        );
        std::process::exit(2);
    }

    let sat_config_id = ObjectId::parse_str(&args[2])?;
    let start = format!("{}T00:00:00", args[3]);
    let end = format!("{}T23:59:59", args[4]);
    let download_type = match args.get(5).map(String::as_str) {
        Some("received") => DownloadType::Received,
        _ => DownloadType::Issued,
    };
    let max_attempts = args.get(6).and_then(|value| value.parse::<u32>().ok());
    let poll_seconds = args.get(7).and_then(|value| value.parse::<u64>().ok());

    let cfg = get_sat_config(&state, &sat_config_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("SAT config not found"))?;
    let output_dir = PathBuf::from("data/cfdi_probe")
        .join(cfg.company_id.to_hex())
        .join(download_type.env_value())
        .join(Utc::now().format("%Y%m%d%H%M%S").to_string());

    println!(
        "SAT probe start company_id={} sat_config_id={} rfc={} type={} start={} end={} max_attempts={} poll_seconds={}",
        cfg.company_id,
        sat_config_id.to_hex(),
        cfg.rfc,
        download_type.env_value(),
        start,
        end,
        max_attempts.unwrap_or_else(|| {
            env::var("CFDI_SAT_MAX_ATTEMPTS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(15)
        }),
        poll_seconds.unwrap_or_else(|| {
            env::var("CFDI_SAT_POLL_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(120)
        })
    );

    let result = download_cfdis(
        &cfg.company_id.to_hex(),
        CfdiDownloadRequest {
            cer_path: Some(cfg.cer_path),
            key_path: Some(cfg.key_path),
            key_password: Some(cfg.key_password),
            rfc: Some(cfg.rfc),
            download_type,
            request_type: RequestType::Xml,
            start: Some(start),
            end: Some(end),
            output_dir: Some(output_dir.to_string_lossy().to_string()),
            poll_seconds,
            max_attempts,
        },
    )
    .await?;

    println!(
        "SAT probe done request_id={} estado={} codigo={} paquetes={} numero_cfdis={} output_dir={}",
        result.request_id,
        result.verify.estado_solicitud.unwrap_or_default(),
        result
            .verify
            .codigo_estado_solicitud
            .or(result.verify.cod_estatus)
            .unwrap_or_default(),
        result.packages.len(),
        result.verify.numero_cfdis.unwrap_or_default(),
        result.output_dir
    );

    Ok(())
}
