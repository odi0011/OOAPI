import { useSyncExternalStore } from "react";

/**
 * 当前会话里的交易所密钥。
 *
 * TODO(trading): 后端字段未就绪。密钥只留在内存，不写 localStorage，
 * 不打计费或跨域接口。接通后改为 /api/trading/exchange-keys。
 * 策略页用 exchangeKeyId 引用这里还没作废的那一把。
 */

export interface ExchangeKey {
  id: string;
  name: string;
  exchange: "binance";
  apiKey: string;
  apiSecret: string;
  createdAt: string;
  /** 再绑一把新 Key 时，之前的全部作废。 */
  revoked: boolean;
}

type Listener = () => void;

let keys: ExchangeKey[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getExchangeKeys(): ExchangeKey[] {
  return keys;
}

export function subscribeExchangeKeys(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useExchangeKeys(): ExchangeKey[] {
  return useSyncExternalStore(subscribeExchangeKeys, getExchangeKeys, getExchangeKeys);
}

/** 绑定新 Key，并作废本会话里已有的全部 Key。 */
export function bindExchangeKey(input: {
  name: string;
  exchange: "binance";
  apiKey: string;
  apiSecret: string;
}): ExchangeKey {
  const item: ExchangeKey = {
    ...input,
    id: newId(),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  keys = [item, ...keys.map((row) => ({ ...row, revoked: true }))];
  emit();
  return item;
}

export function removeExchangeKey(id: string) {
  keys = keys.filter((row) => row.id !== id);
  emit();
}
