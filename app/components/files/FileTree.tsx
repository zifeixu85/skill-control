"use client";

import { useState } from "react";
import { ancestorPaths, type TreeNode } from "../../lib/file-tree";
import { formatBytes } from "../../lib/format";
import { ChevronIcon, FileIcon, FolderIcon, LinkIcon } from "../icons";

function TreeLevel({
  nodes,
  depth,
  open,
  toggle,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  open: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="tree-level" aria-label={depth ? undefined : "文件列表"}>
      {nodes.map((node) => {
        const isDirectory = node.type === "directory";
        const expanded = isDirectory && open.has(node.path);
        return (
          <li key={node.path}>
            <button
              type="button"
              aria-expanded={isDirectory ? expanded : undefined}
              aria-current={node.path === selected ? "true" : undefined}
              className={`tree-item ${node.path === selected ? "on" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (isDirectory ? toggle(node.path) : onSelect(node.path))}
              title={node.path}
            >
              {isDirectory ? <ChevronIcon className={`chev ${expanded ? "open" : ""}`} /> : <span className="chev-space" />}
              {isDirectory ? <FolderIcon /> : node.type === "symlink" ? <LinkIcon /> : <FileIcon />}
              <span className="tree-name">{node.name}</span>
              {!isDirectory && node.entry ? <small>{formatBytes(node.entry.size)}</small> : null}
            </button>
            {expanded && node.children.length ? (
              <TreeLevel
                nodes={node.children}
                depth={depth + 1}
                open={open}
                toggle={toggle}
                selected={selected}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function FileTree({
  nodes,
  selected,
  onSelect,
  expandAll,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  expandAll: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(() => {
    if (!expandAll) return new Set(ancestorPaths(selected));
    const all = new Set<string>();
    const walk = (list: TreeNode[]) =>
      list.forEach((node) => {
        if (node.type === "directory") {
          all.add(node.path);
          walk(node.children);
        }
      });
    walk(nodes);
    return all;
  });
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const select = (path: string) => {
    setOpen((current) => new Set([...current, ...ancestorPaths(path)]));
    onSelect(path);
  };
  return <TreeLevel nodes={nodes} depth={0} open={open} toggle={toggle} selected={selected} onSelect={select} />;
}
