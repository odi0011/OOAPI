import React, { useEffect, useMemo, useState } from "react";
import { SortableDataTable } from "./sortable-data-table/sortable-data-table";
import { Pagination as ArcPagination } from "./pagination/pagination";
import { Tabs as ArcTabs, TabsList, TabsTrigger, TabsContent } from "./tabs/tabs";
import { Accordion } from "./accordion/accordion";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Select, Button } from "./controls";

export function Pagination({ current = 1, defaultCurrent = 1, total = 0, pageSize = 20, onChange, onShowSizeChange, showTotal, showSizeChanger, pageSizeOptions = [10, 20, 50, 100], hideOnSinglePage, ...props }) {
  if (hideOnSinglePage && total <= pageSize) return null;
  return <div className="arc-pagination">{showTotal && <span>{showTotal(total, [(current - 1) * pageSize + 1, Math.min(current * pageSize, total)])}</span>}<ArcPagination label="分页" page={current} pageCount={Math.max(1, Math.ceil(total / pageSize))} onPageChange={v => onChange?.(v, pageSize)}/>{showSizeChanger && <Select value={pageSize} options={pageSizeOptions.map(v => ({ value: Number(v), label: `${v} 条/页` }))} onChange={v => { onShowSizeChange?.(1, v); onChange?.(1, v); }}/>}</div>;
}
const get = (row, path) => Array.isArray(path) ? path.reduce((v, k) => v?.[k], row) : row[path];
export function Table({ dataSource = [], columns = [], rowKey = "key", loading, pagination, onChange, rowSelection, onRow, rowClassName, scroll, className = "", locale, expandable, summary, size, tableLayout, showHeader = true, ...props }) {
  const initialColumn = columns.find(c => c.defaultSortOrder);
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10), [sort, setSort] = useState(initialColumn ? { key: String(initialColumn.key || initialColumn.dataIndex), direction: initialColumn.defaultSortOrder === "descend" ? "desc" : "asc" } : null);
  const [expanded, setExpanded] = useState(expandable?.defaultExpandedRowKeys || []);
  const expandedKeys = expandable?.expandedRowKeys || expanded;
  const config = pagination === false ? null : { current: page, pageSize, ...pagination };
  const keyFor = row => typeof rowKey === "function" ? rowKey(row) : row[rowKey] ?? dataSource.indexOf(row);
  const sorted = useMemo(() => { const column = columns.find(c => String(c.key || c.dataIndex) === sort?.key); if (!column || typeof column.sorter !== "function") return dataSource; return [...dataSource].sort((a, b) => column.sorter(a, b) * (sort.direction === "asc" ? 1 : -1)); }, [dataSource, sort, columns]);
  const current = config ? Math.max(1, config.current || 1) : 1;
  const paged = config && (!config.total || config.total <= dataSource.length) ? sorted.slice((current - 1) * config.pageSize, current * config.pageSize) : sorted;
  const cols = columns.filter(c => !c.hidden).flatMap(c => c.children || c).map((c, i) => ({
    key: String(c.key || c.dataIndex || `column-${i}`), label: c.title, width: c.width, sortable: !!c.sorter, fixed: c.fixed, numeric: c.align === "right", className: c.className,
    render: (_, row) => { const value = c.render ? c.render(get(row, c.dataIndex), row, dataSource.indexOf(row)) : get(row, c.dataIndex); const content = value && typeof value === "object" && !React.isValidElement(value) && "children" in value ? value.children : value; return c.ellipsis ? <div className="arc-cell-ellipsis" title={typeof content === "string" ? content : undefined}>{content}</div> : content; },
  }));
  if (expandable?.expandedRowRender) cols.unshift({ key: "expand", label: "", width: 44, sortable: false, render: (_, row) => expandable.rowExpandable && !expandable.rowExpandable(row) ? null : <Button size="small" type="text" aria-label={expandedKeys.includes(keyFor(row)) ? "收起详情" : "展开详情"} aria-expanded={expandedKeys.includes(keyFor(row))} icon={expandedKeys.includes(keyFor(row)) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>} onClick={() => { const isOpen = !expandedKeys.includes(keyFor(row)); const next = isOpen ? [...expandedKeys, keyFor(row)] : expandedKeys.filter(k => k !== keyFor(row)); setExpanded(next); expandable.onExpand?.(isOpen, row); expandable.onExpandedRowsChange?.(next); }}/> });
  const selectionKeys = rowSelection?.selectedRowKeys?.map(String);
  const pageChange = (next, limit) => { setPage(next); setPageSize(limit); config?.onChange?.(next, limit); onChange?.({ ...config, current: next, pageSize: limit }, {}, sort ? { columnKey: sort.key, field: sort.key, order: sort.direction === "asc" ? "ascend" : "descend" } : {}); };
  return <div className={`arc-data-table ${className}`} data-hide-header={!showHeader || undefined} aria-busy={!!loading}>
    {loading && <div className="arc-table-loading" role="status">加载中…</div>}
    <SortableDataTable rows={paged} columns={cols} rowKey={row => String(keyFor(row))} caption="" defaultSort={sort} expandedRow={expandable?.expandedRowRender ? (row, i) => expandedKeys.includes(keyFor(row)) ? expandable.expandedRowRender(row, i, 0, true) : null : undefined} emptyMessage={loading ? "加载中…" : locale?.emptyText || "暂无数据"} manualSort onSortChange={next => { setSort(next); const column = columns.find(c => String(c.key || c.dataIndex) === next.key); onChange?.(config || {}, {}, { columnKey: next.key, field: column?.dataIndex, order: next.direction === "asc" ? "ascend" : "descend", column }); }} selectable={!!rowSelection} selectedKeys={selectionKeys} onSelectionChange={keys => { const selected = dataSource.filter(r => keys.includes(String(keyFor(r)))); rowSelection?.onChange?.(keys.map(k => dataSource.find(r => String(keyFor(r)) === k)).map((r,i) => r ? keyFor(r) : (selectionKeys || []).includes(keys[i]) ? rowSelection.selectedRowKeys[selectionKeys.indexOf(keys[i])] : keys[i]), selected); }} onRow={onRow} rowClassName={rowClassName} minWidth={scroll?.x} maxHeight={scroll?.y} itemName={{ one: "项", other: "项" }}/>
    {summary?.(paged)}{config && <Pagination {...config} current={current} total={config.total ?? dataSource.length} onChange={pageChange}/>}
  </div>;
}
Table.Column = () => null;
export function Tabs({ items = [], activeKey, defaultActiveKey, onChange, tabBarExtraContent, className = "", style, destroyInactiveTabPane, type, size }) {
  const [local, setLocal] = useState(defaultActiveKey ?? items[0]?.key);
  const selected = activeKey ?? local;
  const [visited, setVisited] = useState(() => new Set([selected]));
  useEffect(() => { setVisited(old => old.has(selected) ? old : new Set([...old, selected])); }, [selected]);
  return <ArcTabs className={`arc-tabs ${className}`} style={style} value={selected} onValueChange={key => { setLocal(key); onChange?.(key); }}><div className="arc-tab-header"><TabsList>{items.map(i => <TabsTrigger key={i.key} value={i.key} disabled={i.disabled}>{i.label}</TabsTrigger>)}</TabsList>{tabBarExtraContent}</div>{items.filter(i => i.key === selected || !destroyInactiveTabPane && visited.has(i.key)).map(i => <TabsContent key={i.key} value={i.key} forceMount={!destroyInactiveTabPane} hidden={i.key !== selected}>{i.children}</TabsContent>)}</ArcTabs>;
}
export function Collapse({ items = [], children, defaultActiveKey, activeKey, onChange, className = "", style }) { const list = items.length ? items : React.Children.toArray(children).map(c => ({ key: c.key, label: c.props.header, children: c.props.children })); const initial = activeKey ?? defaultActiveKey; return <div className={className} style={style}><Accordion defaultOpen={initial == null ? -1 : list.findIndex(i => (Array.isArray(initial) ? initial : [initial]).includes(i.key))} items={list.map(i => ({ title: i.label, content: i.children }))}/></div>; }
Collapse.Panel = () => null;
