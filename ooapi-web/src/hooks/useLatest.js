// 列表请求竞态防护
// ===========================================================================
// 场景：快速切换筛选条件 / 连续点刷新时，先发出的请求可能后返回，
// 旧数据会把新数据覆盖掉（经典 race condition）。
//
// 用法：
//   const { begin, isLatest } = useLatest();
//   const load = useCallback(async () => {
//     const token = begin();
//     const data = await API.get(...);
//     if (!isLatest(token)) return;   // 期间又发了新请求，丢弃本次结果
//     setItems(data);
//   }, [begin, isLatest]);
//
// isLatest 同时覆盖「组件已卸载」的情况：卸载时会作废所有未完成的 token，
// 避免对已卸载组件 setState（React 18 不再报警告，但仍是浪费与潜在错乱）。
import { useCallback, useEffect, useRef } from "react";

export default function useLatest() {
  const seqRef = useRef(0);

  useEffect(() => () => {
    seqRef.current += 1;
  }, []);

  const begin = useCallback(() => ++seqRef.current, []);
  const isLatest = useCallback((token) => token === seqRef.current, []);

  return { begin, isLatest };
}
