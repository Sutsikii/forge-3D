import { useCallback, useRef, type RefObject } from "react";
import type { ViewerHandle } from "../components/Viewer3D";
import { api, type LibraryItem } from "./api";
import { useStore } from "./store";

/**
 * Returns an onLoaded callback for the viewer that captures a thumbnail for
 * items that have none yet (or whose thumbnail predates the textured model).
 */
export function useThumbnail(item: LibraryItem | null, viewer: RefObject<ViewerHandle | null>) {
  const busy = useRef(new Set<string>());
  return useCallback(() => {
    if (!item) return;
    const thumb = item.available.thumb;
    const textured = item.available.textured;
    const stale = !thumb || (textured && thumb.mtime < textured.mtime);
    if (!stale || busy.current.has(item.id)) return;
    busy.current.add(item.id);
    setTimeout(async () => {
      try {
        const blob = await viewer.current?.capture(384);
        if (!blob) return;
        const updated = await api.saveThumbnail(item.id, blob);
        const lib = useStore.getState().library.map((i) => (i.id === updated.id ? updated : i));
        useStore.getState().set({ library: lib });
      } catch {
        /* thumbnail is best effort */
      } finally {
        busy.current.delete(item.id);
      }
    }, 350);
  }, [item, viewer]);
}
