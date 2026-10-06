import React from "react";
import { CodeBlock as ArcCodeBlock } from "./arc/code-block/code-block";
export default function CodeBlock({ lang = "text", code = "", title, className = "" }) { return <div className={className}><ArcCodeBlock code={String(code)} language={lang} filename={title} maxLines={24}/></div>; }
