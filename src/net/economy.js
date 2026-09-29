// Economy actions, resolved against whichever authority is in charge.
//
// Online the server decides and its response replaces the save. Offline the
// same pure functions run against the local sandbox copy. Callers get the same
// result shape either way and never need to know which happened.

import { buyUpgrade, burnRestore, equipFriend } from '../game/economy.js';

export function createEconomy(app) {
  const localApply = (fn) => {
    const res = fn(app.save);
    if (!res.ok) return { ok: false, reason: res.reason };
    app.save = res.save;
    app.persist();
    return { ok: true, ...res };
  };

  const remote = async (call) => {
    try {
      const out = await call();
      app.adoptServerSave(out.save);
      return { ok: true, ...out };
    } catch (err) {
      if (err.code === 'offline') {
        app.online = false;
        app.netStatus = 'offline';
      }
      return { ok: false, reason: err.message || 'REFUSED' };
    }
  };

  return {
    async buyUpgrade(id) {
      if (!app.online) return localApply((s) => buyUpgrade(s, id));
      return remote(() => app.api.buyUpgrade(id));
    },

    async burnRestore(friendId, toFull) {
      if (!app.online) {
        let save = app.save;
        let spent = 0;
        let restored = false;
        for (let i = 0; i < 32; i++) {
          const res = burnRestore(save, friendId);
          if (!res.ok) {
            if (spent === 0) return { ok: false, reason: res.reason };
            break;
          }
          save = res.save;
          spent += res.spent;
          restored = res.restored;
          if (!toFull || restored) break;
        }
        app.save = save;
        app.persist();
        return { ok: true, spent, restored };
      }
      return remote(() => app.api.burnRestore(friendId, toFull));
    },

    async equip(friendId) {
      if (!app.online) return localApply((s) => equipFriend(s, friendId));
      return remote(() => app.api.equip(friendId));
    },
  };
}
