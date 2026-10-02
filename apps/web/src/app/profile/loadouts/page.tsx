'use client';
import { useEffect, useMemo, useState } from 'react';
import { Lock, Plus, Share2, Trash2, Check } from 'lucide-react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';

interface Weapon { weaponDefIndex: number; weaponName: string; slot: string; skins: number }
interface Skin { id: string; name: string; weaponName: string; weaponDefIndex: number; slot: string; paintIndex: number; rarity: string | null; imageUrl: string | null; minFloat: number; maxFloat: number; statTrakAvailable: boolean; souvenirAvailable: boolean; priceMaxUsd: number | null; requiredLevel: number }
interface Sticker { id: string; name: string; imageUrl: string | null }
interface Item { id: string; slot: string; weaponDefIndex: number; skin: { name: string; weaponName: string; imageUrl: string | null } | null; float: number; pattern: number; statTrak: boolean; statTrakCount: number; nameTag: string | null; stickers: Array<{ slotIndex: number; sticker: { name: string; imageUrl: string | null } }> }
interface Loadout { id: string; name: string; shareCode: string | null; isActive: boolean; items: Array<{ weaponDefIndex: number; item: Item }> }
interface Access { level: number; floatEditing: boolean; stickerCrafts: boolean; customLoadouts: boolean; expiresAt: string | null }

const SLOT_LABEL: Record<string, string> = { PISTOL: 'Pistolen', SMG: 'SMGs', RIFLE: 'Gewehre', AWP: 'Scharfschützen', SHOTGUN: 'Schrotflinten', MACHINE_GUN: 'MGs', KNIFE: 'Messer', GLOVES: 'Handschuhe' };
const RARITY: Record<string, string> = { 'Consumer Grade': '#b0c3d9', 'Industrial Grade': '#5e98d9', 'Mil-Spec Grade': '#4b69ff', Restricted: '#8847ff', Classified: '#d32ce6', Covert: '#eb4b4b', Contraband: '#e4ae39', Extraordinary: '#eb4b4b' };
const STICKER_SLOTS = 5;
interface PriceEntry { wear: string; variant: string; priceUsd: number; requiredLevel: number }
interface PlacedSticker { sticker: Sticker; wear: number; rotation: number; scale: number }
function wearEnum(f: number) {
  return f < 0.07 ? 'FACTORY_NEW' : f < 0.15 ? 'MINIMAL_WEAR' : f < 0.38 ? 'FIELD_TESTED' : f < 0.45 ? 'WELL_WORN' : 'BATTLE_SCARRED';
}
const NAME_TAG_MAX = 20;

const skinName = (name: string | null | undefined) => (name && name.trim() ? name : 'Vanilla');
const img = (url: string | null | undefined, size = '256fx192f') => (url ? `${url}/${size}` : '');
function wearName(f: number) {
  return f < 0.07 ? 'Factory New' : f < 0.15 ? 'Minimal Wear' : f < 0.38 ? 'Field-Tested' : f < 0.45 ? 'Well-Worn' : 'Battle-Scarred';
}

export default function SkinChanger() {
  const { me, login } = useAuth();
  const signedIn = !!me.user;
  const access = useApi<Access>(signedIn ? '/skin-access' : null);
  const weapons = useApi<{ weapons: Weapon[] }>('/skins/weapons');
  const inv = useApi<{ items: Item[]; limit: number }>(signedIn ? '/inventory' : null);
  const lo = useApi<{ loadouts: Loadout[]; limit: number }>(signedIn ? '/loadouts' : null);
  const reload = () => { inv.reload(); lo.reload(); };
  const act = useAction(reload);

  const [slot, setSlot] = useState('RIFLE');
  const [weapon, setWeapon] = useState<Weapon | null>(null);
  const [filter, setFilter] = useState('');
  const skins = useApi<{ skins: Skin[] }>(weapon ? `/skins?weaponDefIndex=${weapon.weaponDefIndex}&pageSize=100` : null);
  const [skin, setSkin] = useState<Skin | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  const level = access.data?.level ?? 0;
  const slots = useMemo(() => [...new Set((weapons.data?.weapons ?? []).map((w) => w.slot))], [weapons.data]);
  const inSlot = (weapons.data?.weapons ?? []).filter((w) => w.slot === slot);
  useEffect(() => { if (slots.length && !slots.includes(slot)) setSlot(slots[0]!); }, [slots, slot]);
  useEffect(() => { if (!target && lo.data?.loadouts[0]) setTarget(lo.data.loadouts.find((l) => l.isActive)?.id ?? lo.data.loadouts[0].id); }, [lo.data, target]);
  useEffect(() => { setSkin(null); }, [weapon]);

  if (!signedIn) return <><PageTitle title="Skin-Changer" /><Card><p className="mb-3 text-sm text-muted">Melde dich an, um deine Skins zu verwalten.</p><Button onClick={() => login('/profile/loadouts')}>Mit Steam anmelden</Button></Card></>;

  const visibleSkins = (skins.data?.skins ?? []).filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
  const current = lo.data?.loadouts.find((l) => l.id === target);

  return (
    <>
      <PageTitle title="Skin-Changer" subtitle="Wähle Waffe und Skin, stelle Float und Pattern ein und lege ihn in einen deiner Loadouts." actions={
        <div className="rounded-lg border bg-card px-3 py-1.5 text-sm">Dein Level <b className="text-primary">{level}</b>{access.data?.expiresAt && <span className="text-xs text-muted"> · bis {new Date(access.data.expiresAt).toLocaleString('de-DE')}</span>}</div>} />
      {act.error && <div className="mb-3"><ErrorBox message={act.error} /></div>}

      <LoadoutBar loadouts={lo.data?.loadouts ?? []} limit={lo.data?.limit ?? 3} target={target} setTarget={setTarget} act={act} loading={lo.loading && !lo.data} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <div role="tablist" className="mb-3 flex flex-wrap gap-1.5">
            {slots.map((s) => (
              <button key={s} role="tab" aria-selected={slot === s} onClick={() => { setSlot(s); setWeapon(null); }} className={cn('rounded-lg border px-3 py-1.5 text-sm font-medium', slot === s ? 'bg-primary text-primary-fg' : 'bg-card hover:bg-card-hover')}>{SLOT_LABEL[s] ?? s}</button>
            ))}
          </div>
          {weapons.loading && !weapons.data ? <Loading /> : !weapons.data?.weapons.length ? <Card><p className="text-sm text-muted">Der Skin-Katalog ist noch leer. Ein Admin kann ihn unter Admin → Skin-Rechte synchronisieren.</p></Card> : (
            <div className="mb-4 flex flex-wrap gap-2">
              {inSlot.map((w) => (
                <button key={w.weaponDefIndex} onClick={() => setWeapon(w)} aria-pressed={weapon?.weaponDefIndex === w.weaponDefIndex} className={cn('rounded-lg border px-3 py-2 text-left text-sm', weapon?.weaponDefIndex === w.weaponDefIndex ? 'border-primary bg-card-hover' : 'bg-card hover:bg-card-hover')}>
                  <div className="font-semibold">{w.weaponName}</div><div className="text-xs text-muted">{w.skins} Skins</div>
                </button>
              ))}
            </div>
          )}

          {weapon && (
            <>
              <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-bold">{weapon.weaponName}</h2><div className="w-48"><Input aria-label="Skin filtern" placeholder="Skin filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} /></div></div>
              {skins.loading && !skins.data ? <Loading /> : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                  {visibleSkins.map((s) => {
                    const maybeLocked = s.requiredLevel > level;
                    return (
                      <button key={s.id} onClick={() => setSkin(s)} aria-pressed={skin?.id === s.id} className={cn('group overflow-hidden rounded-xl border bg-card text-left transition hover:bg-card-hover', skin?.id === s.id && 'ring-2 ring-primary')} style={{ borderBottom: `3px solid ${RARITY[s.rarity ?? ''] ?? '#888'}` }}>
                        <div className="relative flex h-24 items-center justify-center bg-elevated p-2">
                          {s.imageUrl && <img src={img(s.imageUrl)} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />}
                          {maybeLocked && <span title="Das genaue Level hängt von Abnutzung und StatTrak ab (siehe Editor)" className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white"><Lock size={11} />bis Lvl {s.requiredLevel}</span>}
                        </div>
                        <div className="p-2"><div className="truncate text-sm font-semibold">{skinName(s.name)}</div><div className="truncate text-xs text-muted">{s.rarity ?? ''}{s.priceMaxUsd === null ? ' · Preis unbekannt' : ` · bis $${Math.round(s.priceMaxUsd)}`}</div></div>
                      </button>
                    );
                  })}
                  {visibleSkins.length === 0 && <p className="col-span-full text-sm text-muted">Keine Skins gefunden.</p>}
                </div>
              )}
            </>
          )}
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          {skin ? <Editor key={skin.id} skin={skin} access={access.data} level={level} loadouts={lo.data?.loadouts ?? []} target={target} setTarget={setTarget} onSaved={reload} /> : <Card className="text-sm text-muted">Wähle links eine Waffe und einen Skin. Hier stellst du dann Float, Pattern, StatTrak und Sticker ein.</Card>}
        </aside>
      </div>

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-bold">Loadout „{current?.name ?? '–'}“</h2>
        {!current?.items.length ? <Card><p className="text-sm text-muted">Dieses Loadout ist leer.</p></Card> : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {current.items.map(({ item }) => (
              <Card key={item.id} className="p-2">
                <div className="flex h-20 items-center justify-center">{item.skin?.imageUrl && <img src={img(item.skin.imageUrl)} alt="" referrerPolicy="no-referrer" className="max-h-full object-contain" />}</div>
                <div className="truncate text-sm font-semibold">{item.skin ? `${item.skin.weaponName} | ${skinName(item.skin.name)}` : `Waffe ${item.weaponDefIndex}`}</div>
                <div className="text-xs text-muted">{item.float.toFixed(3)} · Pattern {item.pattern}{item.statTrak ? ' · ST' : ''}</div>
                <Button variant="ghost" className="mt-1 w-full" onClick={() => void act.run(() => api(`/loadouts/${current.id}/items`, { method: 'PUT', body: { items: current.items.filter((x) => x.item.id !== item.id).map((x) => ({ inventoryItemId: x.item.id })) } }))}><Trash2 size={14} />Entfernen</Button>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="mb-3 text-lg font-bold">Inventar <span className="text-sm font-normal text-muted">({inv.data?.items.length ?? 0}/{inv.data?.limit ?? '–'})</span></h2>
        {!inv.data?.items.length ? <Card><p className="text-sm text-muted">Dein Inventar ist leer.</p></Card> : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {inv.data.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 rounded-lg border bg-card p-2 text-sm">
                {i.skin?.imageUrl && <img src={img(i.skin.imageUrl, '96fx72f')} alt="" referrerPolicy="no-referrer" className="h-12 w-16 object-contain" />}
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{i.skin ? `${i.skin.weaponName} | ${skinName(i.skin.name)}` : `Waffe ${i.weaponDefIndex}`}</div><div className="text-xs text-muted">{wearName(i.float)} · {i.float.toFixed(3)} · Pattern {i.pattern}</div></div>
                <Button variant="ghost" aria-label="Item löschen" onClick={() => void act.run(() => api(`/inventory/${i.id}`, { method: 'DELETE' }))}><Trash2 size={15} /></Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function LoadoutBar({ loadouts, limit, target, setTarget, act, loading }: { loadouts: Loadout[]; limit: number; target: string | null; setTarget: (id: string) => void; act: ReturnType<typeof useAction>; loading: boolean }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  if (loading) return <Loading />;
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-3">
        {loadouts.map((l) => (
          <button key={l.id} onClick={() => setTarget(l.id)} aria-pressed={target === l.id} className={cn('rounded-xl border bg-card p-3 text-left transition hover:bg-card-hover', target === l.id && 'ring-2 ring-primary')}>
            <div className="flex items-center justify-between"><b>{l.name}</b>{l.isActive && <span className="flex items-center gap-1 text-xs text-success"><Check size={12} />aktiv im Spiel</span>}</div>
            <div className="mt-0.5 text-xs text-muted">{l.items.length} Items{l.shareCode ? ` · ${l.shareCode}` : ''}</div>
            {target === l.id && (
              <div className="mt-2 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                {!l.isActive && <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act.run(() => api(`/loadouts/${l.id}/activate`, { method: 'POST' }))}>Aktivieren</Button>}
                <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act.run(() => api(`/loadouts/${l.id}/share-code`, { method: 'POST' }))}><Share2 size={12} />Code</Button>
                <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => { if (confirm(`Loadout „${l.name}“ löschen?`)) void act.run(() => api(`/loadouts/${l.id}`, { method: 'DELETE' })); }}><Trash2 size={12} /></Button>
              </div>
            )}
          </button>
        ))}
        {loadouts.length < limit && (
          <form className="flex items-end gap-2 rounded-xl border border-dashed p-3" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/loadouts', { method: 'POST', body: { name } }); setName(''); }); }}>
            <Input label={`Neues Loadout (${loadouts.length}/${limit})`} required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
            <Button disabled={act.busy} aria-label="Loadout anlegen"><Plus size={16} /></Button>
          </form>
        )}
      </div>
      <form className="mt-3 flex max-w-sm items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/loadouts/import', { method: 'POST', body: { code } }); setCode(''); }); }}>
        <Input label="Loadout per Code importieren" placeholder="CELTIST-XXXXXX" value={code} onChange={(e) => setCode(e.target.value)} /><Button variant="secondary" disabled={act.busy || code.length < 6}>Import</Button>
      </form>
    </div>
  );
}

function Editor({ skin, access, level, loadouts, target, setTarget, onSaved }: { skin: Skin; access: Access | undefined; level: number; loadouts: Loadout[]; target: string | null; setTarget: (id: string) => void; onSaved: () => void }) {
  const canFloat = !!access?.floatEditing;
  const [float, setFloat] = useState(Math.max(skin.minFloat, Math.min(skin.maxFloat, 0.07)));
  const [pattern, setPattern] = useState('1');
  const [statTrak, setStatTrak] = useState(false);
  const [nameTag, setNameTag] = useState('');
  const [stickers, setStickers] = useState<Array<PlacedSticker | null>>(Array(STICKER_SLOTS).fill(null));
  const detail = useApi<{ prices: PriceEntry[] }>(`/skins/${skin.id}`);
  const [pickSlot, setPickSlot] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const found = useApi<{ stickers: Sticker[] }>(pickSlot !== null && q.length >= 2 ? `/stickers?q=${encodeURIComponent(q)}&pageSize=12` : null);
  const act = useAction(onSaved);
  const usedFloat = canFloat ? float : 0.07;
  const variant = statTrak && skin.statTrakAvailable ? 'STATTRAK' : 'NORMAL';
  const entry = detail.data?.prices.find((p) => p.wear === wearEnum(usedFloat) && p.variant === variant);
  const needed = detail.data ? (entry?.requiredLevel ?? 3) : skin.requiredLevel;
  const locked = needed > level;
  const patternValid = /^\d{1,4}$/.test(pattern) && Number(pattern) <= 1000;
  const loadout = loadouts.find((l) => l.id === target);

  const save = (toLoadout: boolean) => void act.run(async () => {
    const created = await api<{ id: string }>('/inventory', {
      method: 'POST',
      body: {
        slot: skin.slot, weaponDefIndex: skin.weaponDefIndex, skinId: skin.id, floatValue: canFloat ? float : 0.07, paintSeed: Number(pattern),
        statTrak: statTrak && skin.statTrakAvailable, nameTag: nameTag || null,
        stickers: stickers.flatMap((s, i) => (s ? [{ stickerId: s.sticker.id, slotIndex: i, wear: s.wear, rotation: s.rotation, scale: s.scale }] : [])),
      },
    });
    if (toLoadout) {
      // First use: no loadout yet, so create one instead of leaving the button dead.
      const dest = loadout ?? { ...(await api<{ id: string }>('/loadouts', { method: 'POST', body: { name: 'Loadout 1' } })), items: [] as Loadout['items'] };
      const keep = dest.items.filter((x) => x.weaponDefIndex !== skin.weaponDefIndex).map((x) => ({ inventoryItemId: x.item.id }));
      await api(`/loadouts/${dest.id}/items`, { method: 'PUT', body: { items: [...keep, { inventoryItemId: created.id }] } });
    }
  });

  return (
    <Card className="space-y-4">
      <div className="flex h-36 items-center justify-center rounded-lg bg-elevated p-2" style={{ borderBottom: `3px solid ${RARITY[skin.rarity ?? ''] ?? '#888'}` }}>
        {skin.imageUrl && <img src={img(skin.imageUrl, '360fx270f')} alt={`${skin.weaponName} | ${skinName(skin.name)}`} referrerPolicy="no-referrer" className="max-h-full object-contain" />}
      </div>
      <div><h2 className="font-bold">{skin.weaponName} | {skinName(skin.name)}</h2><p className="text-xs text-muted">{skin.rarity} · {entry ? `${wearName(usedFloat)}${variant === 'STATTRAK' ? ' StatTrak' : ''}: ca. ${Math.round(entry.priceUsd)} → Level ${needed}` : detail.data ? `kein Marktpreis für diese Variante → Level ${needed}` : 'Preis wird geladen …'}</p></div>

      <div>
        <div className="mb-1 flex justify-between text-sm"><span className="text-muted">Float</span><span className="font-mono">{float.toFixed(4)} · {wearName(float)}</span></div>
        <input type="range" aria-label="Float" min={skin.minFloat} max={skin.maxFloat} step={0.0005} value={float} disabled={!canFloat} onChange={(e) => setFloat(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
        {!canFloat && <p className="text-xs text-muted">Float-Bearbeitung ist für dich nicht freigeschaltet (Standardwert).</p>}
      </div>

      <div>
        <div className="flex items-end gap-2">
          <Input label="Pattern (ganze Zahl 0–1000)" inputMode="numeric" value={pattern} aria-invalid={!patternValid} onChange={(e) => setPattern(e.target.value.replace(/[^\d]/g, ''))} />
          <Button variant="secondary" type="button" onClick={() => setPattern(String(Math.floor(Math.random() * 1001)))}>Zufall</Button>
        </div>
        {!patternValid && <p className="mt-1 text-xs text-danger">Das Pattern muss eine ganze Zahl von 0 bis 1000 sein.</p>}
      </div>

      {skin.statTrakAvailable && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={statTrak} onChange={(e) => setStatTrak(e.target.checked)} />StatTrak™</label>}
      <Input label={`Name-Tag (max. ${NAME_TAG_MAX})`} maxLength={NAME_TAG_MAX} value={nameTag} onChange={(e) => setNameTag(e.target.value)} />

      <div>
        <div className="mb-1 text-sm text-muted">Sticker</div>
        <div className="grid grid-cols-5 gap-1.5">
          {stickers.map((s, i) => (
            <button key={i} type="button" onClick={() => setPickSlot(pickSlot === i ? null : i)} aria-label={`Sticker-Slot ${i + 1}`} className={cn('flex h-12 items-center justify-center rounded-lg border bg-elevated', pickSlot === i && 'ring-2 ring-primary')}>
              {s?.sticker.imageUrl ? <img src={img(s.sticker.imageUrl, '64fx48f')} alt={s.sticker.name} referrerPolicy="no-referrer" className="max-h-full" /> : <Plus size={14} className="text-muted" />}
            </button>
          ))}
        </div>
        {pickSlot !== null && (
          <div className="mt-2 space-y-2">
            <Input aria-label="Sticker suchen" placeholder="Sticker suchen (min. 2 Zeichen) …" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="max-h-40 overflow-y-auto rounded-lg border">
              {found.data?.stickers.map((s) => (
                <button key={s.id} type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-card-hover" onClick={() => { setStickers(stickers.map((x, i) => (i === pickSlot ? { sticker: s, wear: 0, rotation: 0, scale: 1 } : x))); setQ(''); }}>
                  {s.imageUrl && <img src={img(s.imageUrl, '48fx36f')} alt="" referrerPolicy="no-referrer" className="h-6" />}<span className="truncate">{s.name}</span>
                </button>
              ))}
              {stickers[pickSlot] && <button type="button" className="w-full px-2 py-1 text-left text-sm text-danger hover:bg-card-hover" onClick={() => { setStickers(stickers.map((x, i) => (i === pickSlot ? null : x))); setPickSlot(null); }}>Sticker entfernen</button>}
            </div>
            {stickers[pickSlot] && (
              <div className="space-y-1 rounded-lg border p-2 text-xs">
                <div className="truncate font-semibold">{stickers[pickSlot]!.sticker.name}</div>
                {([['wear', 'Abnutzung', 0, 1, 0.01], ['rotation', 'Drehung', -180, 180, 1], ['scale', 'Größe', 0.5, 2, 0.05]] as const).map(([key, label, min, max, step]) => (
                  <label key={key} className="flex items-center gap-2"><span className="w-20 text-muted">{label}</span><input type="range" min={min} max={max} step={step} value={stickers[pickSlot]![key]} onChange={(e) => setStickers(stickers.map((x, i) => (i === pickSlot && x ? { ...x, [key]: Number(e.target.value) } : x)))} className="flex-1 accent-[var(--primary)]" /><span className="w-10 text-right font-mono">{stickers[pickSlot]![key].toFixed(key === 'rotation' ? 0 : 2)}</span></label>
                ))}
              </div>
            )}
            {access && !access.stickerCrafts && <p className="text-xs text-muted">Hinweis: Sticker-Crafts sind für dich nicht freigeschaltet; die Prüfung erfolgt beim Speichern.</p>}
          </div>
        )}
      </div>

      {locked && <p className="flex items-center gap-1.5 rounded-lg bg-warning/15 p-2 text-sm text-warning"><Lock size={14} />Diese Variante braucht Level {needed} (du hast {level}). Eine stärkere Abnutzung oder ohne StatTrak ist oft günstiger.</p>}
      {act.error && <ErrorBox message={act.error} />}

      <div className="space-y-2">
        {loadouts.length > 0 && <select aria-label="Ziel-Loadout" value={target ?? ''} onChange={(e) => setTarget(e.target.value)} className="w-full rounded-lg border bg-elevated px-3 py-2 text-sm">{loadouts.map((l) => <option key={l.id} value={l.id}>Loadout: {l.name}</option>)}</select>}
        <Button className="w-full" disabled={locked || !patternValid || act.busy} onClick={() => save(true)}>{loadout ? `In Loadout „${loadout.name}“ speichern` : 'Speichern (erstellt dein erstes Loadout)'}</Button>
        <Button className="w-full" variant="secondary" disabled={locked || !patternValid || act.busy} onClick={() => save(false)}>Nur ins Inventar</Button>
      </div>
    </Card>
  );
}
