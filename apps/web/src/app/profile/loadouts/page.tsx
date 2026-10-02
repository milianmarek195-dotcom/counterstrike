'use client';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Skin { id: string; name: string; weaponName: string; weaponDefIndex: number; slot: string; paintIndex: number; priceMaxUsd: number | null; requiredLevel: number; statTrakAvailable: boolean }
interface Item { id: string; slot: string; weaponDefIndex: number; skin: { name: string; weaponName: string } | null; float: number; pattern: number; statTrak: boolean; souvenir: boolean }
interface Loadout { id: string; name: string; shareCode: string | null; isActive: boolean; items: Array<{ weaponDefIndex: number; item: Item }> }

/**
 * Pattern (paint seed) is a whole number from 0 to 1000. The field only accepts digits and the server validates again,
 * so "661" works while "661.4" or "-3" are rejected with a clear message.
 */
export default function Loadouts() {
  const { me, login } = useAuth();
  const access = useApi<{ level: number; floatEditing: boolean; customLoadouts: boolean; expiresAt: string | null }>(me.user ? '/skin-access' : null);
  const inv = useApi<{ items: Item[]; limit: number }>(me.user ? '/inventory' : null);
  const lo = useApi<{ loadouts: Loadout[]; limit: number }>(me.user ? '/loadouts' : null);
  const reload = () => { inv.reload(); lo.reload(); };
  const act = useAction(reload);
  const [q, setQ] = useState('');
  const skins = useApi<{ skins: Skin[] }>(q.length >= 2 ? `/skins?q=${encodeURIComponent(q)}&pageSize=12` : null);
  const [skin, setSkin] = useState<Skin | null>(null);
  const [float, setFloat] = useState('0.07');
  const [pattern, setPattern] = useState('0');
  const [statTrak, setStatTrak] = useState(false);
  const [newName, setNewName] = useState('');

  if (!me.user) return <><PageTitle title="Skins & Loadouts" /><Button onClick={() => login('/profile/loadouts')}>Mit Steam anmelden</Button></>;
  const patternValid = /^\d{1,4}$/.test(pattern) && Number(pattern) <= 1000;
  const lvl = access.data?.level ?? 0;

  const addItem = () => {
    if (!skin || !patternValid) return;
    void act.run(() => api('/inventory', { method: 'POST', body: { slot: skin.slot, weaponDefIndex: skin.weaponDefIndex, skinId: skin.id, floatValue: Number(float), paintSeed: Number(pattern), statTrak } }));
  };

  return (
    <>
      <PageTitle title="Skins & Loadouts" subtitle={`Dein Skin-Level: ${lvl}${access.data?.expiresAt ? ` (bis ${new Date(access.data.expiresAt).toLocaleString('de-DE')})` : ''}. Level werden von Admins vergeben.`} />
      {act.error && <ErrorBox message={act.error} />}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-lg font-bold">Inventar {inv.data && <span className="text-sm font-normal text-muted">({inv.data.items.length}/{inv.data.limit})</span>}</h2>
          <Card className="mb-4 space-y-3">
            <Input label="Skin suchen (min. 2 Zeichen)" value={q} onChange={(e) => setQ(e.target.value)} />
            {skins.data && <div className="max-h-44 overflow-y-auto rounded-lg border">{skins.data.skins.length === 0 ? <p className="p-3 text-sm text-muted">Kein Skin gefunden. Hat ein Admin den Katalog synchronisiert?</p> : skins.data.skins.map((s) => (
              <button key={s.id} type="button" onClick={() => setSkin(s)} className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-card-hover ${skin?.id === s.id ? 'bg-card-hover' : ''}`}><span>{s.weaponName} | {s.name}</span><span className="text-xs text-muted">Level {s.requiredLevel}</span></button>
            ))}</div>}
            {skin && (
              <div className="grid grid-cols-2 gap-3">
                <Input label="Float (0–1)" inputMode="decimal" value={float} disabled={!access.data?.floatEditing} onChange={(e) => setFloat(e.target.value)} />
                <Input label="Pattern (ganze Zahl 0–1000)" inputMode="numeric" value={pattern} aria-invalid={!patternValid} onChange={(e) => setPattern(e.target.value.replace(/[^\d]/g, ''))} />
                {!patternValid && <p className="col-span-2 text-xs text-danger">Das Pattern muss eine ganze Zahl zwischen 0 und 1000 sein.</p>}
                {skin.statTrakAvailable && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={statTrak} onChange={(e) => setStatTrak(e.target.checked)} /> StatTrak™</label>}
                <Button className="col-span-2" disabled={!patternValid || act.busy} onClick={addItem}>Zum Inventar hinzufügen</Button>
                {!access.data?.floatEditing && <p className="col-span-2 text-xs text-muted">Float-Bearbeitung ist für dich nicht freigeschaltet; es gilt der Standardwert.</p>}
              </div>
            )}
          </Card>
          {!inv.data?.items.length ? <Empty>Dein Inventar ist leer.</Empty> : (
            <ul className="space-y-2">{inv.data.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between rounded-lg border bg-card p-3 text-sm">
                <span>{i.skin ? `${i.skin.weaponName} | ${i.skin.name}` : `Waffe ${i.weaponDefIndex}`}<span className="block text-xs text-muted">Float {i.float} · Pattern {i.pattern}{i.statTrak ? ' · StatTrak' : ''}</span></span>
                <Button variant="ghost" onClick={() => void act.run(() => api(`/inventory/${i.id}`, { method: 'DELETE' }))}>Löschen</Button>
              </li>
            ))}</ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-bold">Loadouts {lo.data && <span className="text-sm font-normal text-muted">({lo.data.loadouts.length}/{lo.data.limit})</span>}</h2>
          {lo.loading && !lo.data ? <Loading /> : (
            <div className="space-y-3">
              {lo.data?.loadouts.map((l) => (
                <Card key={l.id}>
                  <div className="flex items-center justify-between"><h3 className="font-semibold">{l.name} {l.isActive && <span className="text-xs text-success">● aktiv</span>}</h3>
                    <span className="flex gap-1">{!l.isActive && <Button variant="secondary" onClick={() => void act.run(() => api(`/loadouts/${l.id}/activate`, { method: 'POST' }))}>Aktivieren</Button>}<Button variant="ghost" onClick={() => void act.run(() => api(`/loadouts/${l.id}`, { method: 'DELETE' }))}>Löschen</Button></span></div>
                  <p className="mt-1 text-xs text-muted">{l.items.length} Items{l.shareCode ? ` · Code ${l.shareCode}` : ''}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {inv.data?.items.map((i) => { const on = l.items.some((x) => x.item.id === i.id); return (
                      <button key={i.id} aria-pressed={on} className={`rounded-md border px-2 py-1 text-xs ${on ? 'bg-primary text-primary-fg' : 'hover:bg-card-hover'}`} onClick={() => {
                        const ids = l.items.map((x) => x.item.id).filter((id) => id !== i.id); if (!on) ids.push(i.id);
                        void act.run(() => api(`/loadouts/${l.id}/items`, { method: 'PUT', body: { items: ids.map((inventoryItemId) => ({ inventoryItemId })) } }));
                      }}>{i.skin?.name ?? i.weaponDefIndex}</button>); })}
                  </div>
                  <Button className="mt-2" variant="secondary" onClick={() => void act.run(() => api(`/loadouts/${l.id}/share-code`, { method: 'POST' }))}>Share-Code erzeugen</Button>
                </Card>
              ))}
              {(lo.data?.loadouts.length ?? 0) < (lo.data?.limit ?? 3) && (
                <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/loadouts', { method: 'POST', body: { name: newName } }); setNewName(''); }); }}>
                  <Input label="Neues Loadout" required maxLength={40} value={newName} onChange={(e) => setNewName(e.target.value)} /><Button disabled={act.busy}>Anlegen</Button>
                </form>
              )}
              <ImportBox onDone={reload} />
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function ImportBox({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const act = useAction(() => { setCode(''); onDone(); });
  return (
    <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act.run(() => api('/loadouts/import', { method: 'POST', body: { code } })); }}>
      <Input label="Loadout importieren (CELTIST-XXXXXX)" value={code} onChange={(e) => setCode(e.target.value)} /><Button variant="secondary" disabled={act.busy || code.length < 6}>Import</Button>
      {act.error && <ErrorBox message={act.error} />}
    </form>
  );
}
