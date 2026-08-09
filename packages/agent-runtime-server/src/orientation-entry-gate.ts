import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assertDeliveryReceiptBoundToBrief,
  assertOrientationBriefIntegrity,
  parseCarrierSessionOrientationAcknowledgement,
} from '@narada-core/orientation-manifest';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sameCoordinate(left: any, right: any): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

function orientationRequiredSignal(value: unknown): boolean | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'required'].includes(normalized)) return true;
  if (['0', 'false', 'not_required'].includes(normalized)) return false;
  throw new Error('orientation_required_signal_invalid');
}

export function createOrientationEntryGate({
  entryFile = null,
  requiredSignal = null,
  siteRoot,
  dbPath,
}: any = {}) {
  const required = orientationRequiredSignal(requiredSignal);
  if (required === true && !entryFile) {
    throw new Error('orientation_entry_packet_required');
  }
  if (required === false && entryFile) {
    throw new Error('orientation_required_signal_conflict');
  }
  if (!entryFile) {
    return {
      required: false,
      entry_file: null,
      inspect: () => ({
        schema: 'narada.runtime.orientation_entry_gate.v1',
        status: 'not_required',
        ordinary_work_gate: 'open',
        reason: 'carrier_entry_packet_not_supplied',
      }),
      assertOpen: () => null,
    };
  }
  if (!siteRoot) throw new Error('orientation_entry_site_root_required');
  if (!dbPath) throw new Error('orientation_entry_agent_context_db_required');
  const exactEntryFile = resolve(String(entryFile));
  const admittedEntryRoot = resolve(siteRoot, '.ai', 'runtime', 'orientation-entry');
  const entryRelative = relative(admittedEntryRoot, exactEntryFile);
  if (
    entryRelative === '..'
    || entryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(entryRelative)
  ) {
    throw new Error(`orientation_entry_file_outside_admitted_root:${exactEntryFile}`);
  }
  if (!existsSync(exactEntryFile)) {
    throw new Error(`orientation_entry_file_not_found:${exactEntryFile}`);
  }
  const packet = JSON.parse(readFileSync(exactEntryFile, 'utf8'));
  if (
    !packet
    || packet.schema !== 'narada.carrier_entry.orientation_packet.v1'
    || packet.ordinary_work_gate !== 'acknowledgement_required'
  ) {
    throw new Error('orientation_entry_packet_invalid');
  }
  const brief: any = assertOrientationBriefIntegrity(packet.orientation_brief);
  const deliveryReceipt: any = assertDeliveryReceiptBoundToBrief({
    deliveryReceipt: packet.delivery_receipt,
    admissionReceipt: JSON.parse(
      process.env.NARADA_CARRIER_SESSION_ADMISSION_RECEIPT ?? 'null',
    ),
    brief,
  });
  const packetDigest = createHash('sha256')
    .update(canonicalJson(packet))
    .digest('hex');

  const inspect = () => {
    if (!existsSync(dbPath)) {
      return {
        schema: 'narada.runtime.orientation_entry_gate.v1',
        status: 'blocked',
        ordinary_work_gate: 'acknowledgement_required',
        reason: 'agent_context_store_unavailable',
        delivery_receipt_ref: deliveryReceipt.receipt_id,
        packet_digest: packetDigest,
      };
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (
        !tableExists(db, 'orientation_delivery_receipts')
        || !tableExists(db, 'orientation_acknowledgements')
      ) {
        return {
          schema: 'narada.runtime.orientation_entry_gate.v1',
          status: 'blocked',
          ordinary_work_gate: 'acknowledgement_required',
          reason: 'orientation_evidence_tables_unavailable',
          delivery_receipt_ref: deliveryReceipt.receipt_id,
          packet_digest: packetDigest,
        };
      }
      const storedDelivery: any = db.prepare(`
        SELECT receipt_json
        FROM orientation_delivery_receipts
        WHERE receipt_id = ?
        LIMIT 1
      `).get(deliveryReceipt.receipt_id);
      if (
        !storedDelivery
        || storedDelivery.receipt_json !== JSON.stringify(deliveryReceipt)
      ) {
        return {
          schema: 'narada.runtime.orientation_entry_gate.v1',
          status: 'blocked',
          ordinary_work_gate: 'acknowledgement_required',
          reason: 'orientation_delivery_not_admitted',
          delivery_receipt_ref: deliveryReceipt.receipt_id,
          packet_digest: packetDigest,
        };
      }
      const row: any = db.prepare(`
        SELECT acknowledgement_json
        FROM orientation_acknowledgements
        WHERE delivery_receipt_ref = ?
        LIMIT 1
      `).get(deliveryReceipt.receipt_id);
      if (!row) {
        return {
          schema: 'narada.runtime.orientation_entry_gate.v1',
          status: 'blocked',
          ordinary_work_gate: 'acknowledgement_required',
          reason: 'orientation_acknowledgement_required',
          delivery_receipt_ref: deliveryReceipt.receipt_id,
          packet_digest: packetDigest,
        };
      }
      const acknowledgement: any = parseCarrierSessionOrientationAcknowledgement(
        JSON.parse(row.acknowledgement_json),
      );
      if (
        acknowledgement.delivery_receipt_ref !== deliveryReceipt.receipt_id
        || acknowledgement.manifest_id !== brief.manifest_ref.manifest_id
        || acknowledgement.manifest_digest !== brief.manifest_ref.manifest_digest
        || acknowledgement.brief_id !== brief.brief_id
        || acknowledgement.brief_digest !== brief.brief_digest
        || !sameCoordinate(acknowledgement.coordinate, brief.coordinate)
      ) {
        throw new Error('orientation_acknowledgement_binding_mismatch');
      }
      return {
        schema: 'narada.runtime.orientation_entry_gate.v1',
        status: 'open',
        ordinary_work_gate: 'open',
        reason: 'orientation_acknowledged',
        delivery_receipt_ref: deliveryReceipt.receipt_id,
        acknowledgement_ref: acknowledgement.acknowledgement_id,
        acknowledgement_semantics: acknowledgement.acknowledgement_semantics,
        action_admission: acknowledgement.action_admission,
        packet_digest: packetDigest,
      };
    } finally {
      db.close();
    }
  };

  return {
    required: true,
    entry_file: exactEntryFile,
    packet_digest: packetDigest,
    brief,
    delivery_receipt: deliveryReceipt,
    inspect,
    assertOpen() {
      const state: any = inspect();
      if (state.ordinary_work_gate !== 'open') {
        throw new Error(`orientation_acknowledgement_required:${state.reason}`);
      }
      return state;
    },
  };
}
