import { useCallback, useState } from 'react';

import type { Coordinate } from './coordinates';

const useActiveMarkers = (initialMarkers: Coordinate[]) => {
  const [activeMarkers, setActiveMarkers] = useState(initialMarkers);

  const toggleActiveMarkers = useCallback(() => {
    // Shuffle array function
    const shuffled = [...initialMarkers].sort(() => 0.5 - Math.random());
    // Cut the array in half randomly to simulate changes in active markers
    const selected = shuffled.slice(
      0,
      Math.floor(Math.random() * shuffled.length) + 1,
    );
    setActiveMarkers(selected);
  }, [activeMarkers]);

  return { markers: activeMarkers, toggle: toggleActiveMarkers };
};

export default useActiveMarkers;

export function calculateMarkerSize(count: number) {
  const minSize = 3;
  const maxSize = 18;

  if (count <= 1) return minSize;

  // Log scaling for session counts that can range from 1 to 100K+
  // Examples:
  // 1 session: 3px
  // 10 sessions: ~6px
  // 100 sessions: ~9px
  // 1000 sessions: ~12px
  // 10000 sessions: ~15px
  // 100000 sessions: ~18px (max)
  const scaledSize = minSize + Math.log10(count) * 3;

  return Math.max(minSize, Math.min(scaledSize, maxSize));
}
