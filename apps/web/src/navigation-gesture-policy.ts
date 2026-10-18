// Modal surfaces own input until every active surface has released its claim.
export function createNavigationGesturePolicy() {
  const claims = new Set<symbol>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    isBlocked: () => claims.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    acquire() {
      const claim = Symbol();
      claims.add(claim);
      notify();
      return () => { if (claims.delete(claim)) notify(); };
    },
  };
}
