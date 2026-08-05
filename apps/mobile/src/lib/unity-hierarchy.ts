export type UnityHierarchyNode = {
  id: string;
  parentId?: string;
  name: string;
  scene: string;
};

export function visibleUnityHierarchy<T extends UnityHierarchyNode>(
  nodes: T[],
  expandedIds: ReadonlySet<string>,
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  if (normalized) {
    const visible = new Set<string>();
    for (const node of nodes) {
      if (
        !node.name.toLowerCase().includes(normalized) &&
        !node.scene.toLowerCase().includes(normalized)
      ) {
        continue;
      }
      let current: T | undefined = node;
      while (current && !visible.has(current.id)) {
        visible.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
    return nodes.filter((node) => visible.has(node.id));
  }

  const visible = new Set<string>();
  for (const node of nodes) {
    if (!node.parentId) {
      visible.add(node.id);
      continue;
    }
    if (visible.has(node.parentId) && expandedIds.has(node.parentId)) {
      visible.add(node.id);
    }
  }
  return nodes.filter((node) => visible.has(node.id));
}
