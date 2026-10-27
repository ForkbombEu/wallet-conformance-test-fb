import { parse, stringify } from "ini";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  resolveConfigRelativePath,
  resolvePathFrom,
} from "@/logic/runtime-paths";

import type { EffectiveConfig } from "./effective-config";

export interface MaterializeRunIniOptions {
  /** Operator files copied into the run's backup storage before spawn. */
  initializedAssets?: readonly string[];
  /** Absolute path of the selected operator INI. Never modified. */
  operatorIni: string;
  /** Directory receiving `effective.ini`. */
  runRoot: string;
  writablePaths: EffectiveConfig["writablePaths"];
}
type IniSection = Record<string, unknown>;

type ParsedIni = Record<string, unknown>;

/**
 * Writes a per-run copy of the operator INI.
 *
 * Read-only trust/key/asset references are rewritten to absolute paths
 * (resolved exactly as the native loader would, relative to the operator INI)
 * so they keep pointing at the operator's files. Every writable location —
 * wallet attestation/credential/backup storage and the log file — is
 * redirected under the run workspace, and those directories are created.
 *
 * Returns the absolute path of the effective INI.
 */
export function materializeRunIni(options: MaterializeRunIniOptions): string {
  const { operatorIni, runRoot, writablePaths } = options;
  const baseDir = dirname(operatorIni);
  const ini = parse(readFileSync(operatorIni, "utf-8")) as ParsedIni;

  const absolutize = (section: string, key: string) => {
    const s = ini[section] as IniSection | undefined;
    const value = s?.[key];
    if (s && typeof value === "string") {
      s[key] = resolveConfigRelativePath(value, baseDir);
    }
  };
  absolutize("trust", "ca_cert_path");
  absolutize("trust", "federation_trust_anchors_jwks_path");
  absolutize("presentation", "authorize_request_script");

  for (const section of ["issuance", "presentation"]) {
    const s = ini[section] as IniSection | undefined;
    if (s && typeof s.tests_dir === "string") {
      s.tests_dir = resolvePathFrom(baseDir, s.tests_dir);
    }
  }
  const mapping = ini.steps_mapping as IniSection | undefined;
  if (mapping) {
    for (const [key, value] of Object.entries(mapping)) {
      if (typeof value === "string") {
        mapping[key] = resolvePathFrom(baseDir, value);
      }
    }
  }

  // The local Trust Anchor TLS certificate directory is operator key material
  // when explicitly configured; otherwise it is generated per run.
  const trustAnchor = (ini.trust_anchor ??= {}) as IniSection;
  if (typeof trustAnchor.tls_cert_dir === "string") {
    absolutize("trust_anchor", "tls_cert_dir");
  } else {
    trustAnchor.tls_cert_dir = writablePaths.backup;
  }

  const wallet = (ini.wallet ??= {}) as IniSection;
  wallet.wallet_attestations_storage_path = writablePaths.attestation;
  wallet.credentials_storage_path = writablePaths.credentials;
  wallet.backup_storage_path = writablePaths.backup;

  const logging = (ini.logging ??= {}) as IniSection;
  logging.log_file = join(writablePaths.logs, "native.log");

  for (const dir of [
    writablePaths.attestation,
    writablePaths.backup,
    writablePaths.credentials,
    writablePaths.logs,
    dirname(writablePaths.db),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const asset of options.initializedAssets ?? []) {
    cpSync(asset, join(writablePaths.backup, basename(asset)), {
      recursive: true,
    });
  }

  mkdirSync(runRoot, { recursive: true });
  const target = join(runRoot, "effective.ini");
  writeFileSync(target, stringify(ini), { encoding: "utf-8", mode: 0o600 });
  return target;
}
