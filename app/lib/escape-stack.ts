/**
 * Esc closes the top-most open layer only (sheet → dialog → drawer → pending install →
 * inspector). A busy layer stays registered with a no-op close, so Esc during a write
 * neither closes it nor falls through to the layer underneath.
 */
export interface EscapeStack {
  push: (close: () => void) => () => void;
  /** Runs the top layer's close; returns false when no layer is open. */
  escape: () => boolean;
  size: () => number;
}

export function createEscapeStack(): EscapeStack {
  const layers: { id: number; close: () => void }[] = [];
  let sequence = 0;
  return {
    push(close) {
      sequence += 1;
      const layer = { id: sequence, close };
      layers.push(layer);
      return () => {
        const index = layers.findIndex((item) => item.id === layer.id);
        if (index >= 0) layers.splice(index, 1);
      };
    },
    escape() {
      const top = layers[layers.length - 1];
      if (!top) return false;
      top.close();
      return true;
    },
    size: () => layers.length,
  };
}

export const noop = () => {};
