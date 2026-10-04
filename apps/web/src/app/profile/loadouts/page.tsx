'use client';
import { useEffect, useMemo, useState } from 'react';
import { Check, Lock, Plus, Share2, Star, Trash2, X } from 'lucide-react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';

type Side = 'T' | 'CT';
type Team = 'BOTH' | Side;

interface Weapon { weaponDefIndex: number; weaponName: string; slot: string; skins: number }
interface Skin { id: string; name: string; phase: string | null; weaponName: string; weaponDefIndex: number; slot: string; paintIndex: number; rarity: string | null; imageUrl: string | null; minFloat: number; maxFloat: number; statTrakAvailable: boolean; souvenirAvailable: boolean; priceMaxUsd: number | null; requiredLevel: number; side?: string | null }
interface Sticker { id: string; name: string; imageUrl: string | null }
interface Charm { id: string; name: string; rarity: string | null; imageUrl: string | null }
interface ItemSkin { id?: string; name: string; phase: string | null; weaponName: string; imageUrl: string | null; rarity: string | null }
interface Item { id: string; slot: string; weaponDefIndex: number; skin: ItemSkin | null; float: number; pattern: number; statTrak: boolean; statTrakCount: number; nameTag: string | null; favorite?: boolean;
  stickers?: Array<{ slotIndex: number; wear: number; rotation: number | null; scale: number | null; sticker: Sticker }>;
  keychain?: Charm | null; keychainSeed?: number; keychainOffsetX?: number; keychainOffsetY?: number; keychainOffsetZ?: number }
interface LoadoutEntry { weaponDefIndex: number; team: Team; item: Item }
interface Loadout { id: string; name: string; shareCode: string | null; visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'; isActive: boolean; activeT?: boolean; activeCt?: boolean; items: LoadoutEntry[] }
interface Access { level: number; floatEditing: boolean; stickerCrafts: boolean; customLoadouts: boolean; expiresAt: string | null }
interface PriceEntry { wear: string; variant: string; priceUsd: number; requiredLevel: number }
interface PlacedSticker { sticker: Sticker; wear: number; rotation: number; scale: number }

const RARITY: Record<string, string> = { 'Consumer Grade': '#b0c3d9', 'Industrial Grade': '#5e98d9', 'Mil-Spec Grade': '#4b69ff', Restricted: '#8847ff', Classified: '#d32ce6', Covert: '#eb4b4b', Contraband: '#e4ae39', Extraordinary: '#eb4b4b' };
const STICKER_SLOTS = 5;
type Pos = { x: number; y: number; z: number };
/** Starting points for where a charm hangs (game units, 0/0/0 = the weapon's default hang point). Fine tuning is done with the sliders. */
const CHARM_PRESETS: Array<{ label: string; pos: Pos }> = [
  { label: 'Standard', pos: { x: 0, y: 0, z: 0 } },
  { label: 'Ganz vorne', pos: { x: 10, y: 0, z: 0 } },
  { label: 'Vorne', pos: { x: 5, y: 0, z: 0 } },
  { label: 'Hinten', pos: { x: -5, y: 0, z: 0 } },
];
const SAVED_POS_KEY = 'celtist.charmPos';
const loadSavedPos = (): Pos | null => {
  try { const raw = localStorage.getItem(SAVED_POS_KEY); return raw ? (JSON.parse(raw) as Pos) : null; } catch { return null; }
};
const NAME_TAG_MAX = 20;

/** Weapons in the order of the CS2 loadout screen. `side` = which team can buy/hold the weapon by default. */
interface Slot { key: string; name: string; side: Team; defs?: number[] }
const COLUMNS: Array<{ title: string; sections: Array<{ label: string; slots: Slot[] }> }> = [
  {
    title: 'Pistolen',
    sections: [
      { label: 'Start-Pistole', slots: [{ key: '4', name: 'Glock-18', side: 'T' }, { key: '61', name: 'USP-S', side: 'CT' }, { key: '32', name: 'P2000', side: 'CT' }] },
      { label: 'Weitere Pistolen', slots: [{ key: '36', name: 'P250', side: 'BOTH' }, { key: '3', name: 'Five-SeveN', side: 'CT' }, { key: '30', name: 'Tec-9', side: 'T' }, { key: '63', name: 'CZ75-Auto', side: 'BOTH' }, { key: '1', name: 'Desert Eagle', side: 'BOTH' }, { key: '2', name: 'Dual Berettas', side: 'BOTH' }, { key: '64', name: 'R8 Revolver', side: 'BOTH' }] },
    ],
  },
  {
    title: 'Mid-Tier',
    sections: [
      { label: 'Schrotflinten & MGs', slots: [{ key: '35', name: 'Nova', side: 'BOTH' }, { key: '25', name: 'XM1014', side: 'BOTH' }, { key: '27', name: 'MAG-7', side: 'CT' }, { key: '29', name: 'Sawed-Off', side: 'T' }, { key: '14', name: 'M249', side: 'BOTH' }, { key: '28', name: 'Negev', side: 'BOTH' }] },
      { label: 'SMGs', slots: [{ key: '17', name: 'MAC-10', side: 'T' }, { key: '34', name: 'MP9', side: 'CT' }, { key: '33', name: 'MP7', side: 'BOTH' }, { key: '23', name: 'MP5-SD', side: 'BOTH' }, { key: '24', name: 'UMP-45', side: 'BOTH' }, { key: '19', name: 'P90', side: 'BOTH' }, { key: '26', name: 'PP-Bizon', side: 'BOTH' }] },
    ],
  },
  {
    title: 'Gewehre',
    sections: [
      { label: 'Sturmgewehre', slots: [{ key: '13', name: 'Galil AR', side: 'T' }, { key: '10', name: 'FAMAS', side: 'CT' }, { key: '7', name: 'AK-47', side: 'T' }, { key: '16', name: 'M4A4', side: 'CT' }, { key: '60', name: 'M4A1-S', side: 'CT' }, { key: '39', name: 'SG 553', side: 'T' }, { key: '8', name: 'AUG', side: 'CT' }] },
      { label: 'Scharfschützen', slots: [{ key: '40', name: 'SSG 08', side: 'BOTH' }, { key: '9', name: 'AWP', side: 'BOTH' }, { key: '11', name: 'G3SG1', side: 'T' }, { key: '38', name: 'SCAR-20', side: 'CT' }] },
    ],
  },
];
const KNIFE_SLOT: Slot = { key: 'KNIFE', name: 'Messer', side: 'BOTH' };
const GLOVES_SLOT: Slot = { key: 'GLOVES', name: 'Handschuhe', side: 'BOTH' };
const AGENT_SLOT: Slot = { key: 'AGENT', name: 'Agent', side: 'BOTH' };

const skinName = (name: string | null | undefined, phase?: string | null) => `${name && name.trim() ? name : 'Vanilla'}${phase ? ` · ${phase}` : ''}`;
const img = (url: string | null | undefined, size = '256fx192f') => (url ? `${url}/${size}` : '');
const wearEnum = (f: number) => (f < 0.07 ? 'FACTORY_NEW' : f < 0.15 ? 'MINIMAL_WEAR' : f < 0.38 ? 'FIELD_TESTED' : f < 0.45 ? 'WELL_WORN' : 'BATTLE_SCARRED');
const wearName = (f: number) => (f < 0.07 ? 'Factory New' : f < 0.15 ? 'Minimal Wear' : f < 0.38 ? 'Field-Tested' : f < 0.45 ? 'Well-Worn' : 'Battle-Scarred');

/** Knives and gloves are one choice per side whatever the type; every other weapon is its own choice. */
const keyOf = (item: Item) => (item.slot === 'KNIFE' || item.slot === 'GLOVES' || item.slot === 'AGENT' ? item.slot : String(item.weaponDefIndex));

type Equipped = Record<Side, Record<string, Item>>;

/** Per-side view of a loadout: an entry for BOTH counts for T and CT. */
function equippedOf(loadout: Loadout | undefined): Equipped {
  const out: Equipped = { T: {}, CT: {} };
  for (const e of loadout?.items ?? []) {
    const key = keyOf(e.item);
    if (e.team === 'BOTH' || e.team === 'T') out.T[key] = e.item;
    if (e.team === 'BOTH' || e.team === 'CT') out.CT[key] = e.item;
  }
  return out;
}

/** Back to loadout rows: the same item on both sides is stored once as BOTH. */
function rowsOf(eq: Equipped): Array<{ inventoryItemId: string; team: Team }> {
  const rows: Array<{ inventoryItemId: string; team: Team }> = [];
  for (const key of new Set([...Object.keys(eq.T), ...Object.keys(eq.CT)])) {
    const t = eq.T[key];
    const c = eq.CT[key];
    if (t && c && t.id === c.id) rows.push({ inventoryItemId: t.id, team: 'BOTH' });
    else {
      if (t) rows.push({ inventoryItemId: t.id, team: 'T' });
      if (c) rows.push({ inventoryItemId: c.id, team: 'CT' });
    }
  }
  return rows;
}

export default function SkinChanger() {
  const { me, login } = useAuth();
  const signedIn = !!me.user;
  const access = useApi<Access>(signedIn ? '/skin-access' : null);
  const inv = useApi<{ items: Array<Item>; limit: number }>(signedIn ? '/inventory' : null);
  const lo = useApi<{ loadouts: Loadout[]; limit: number }>(signedIn ? '/loadouts' : null);
  const reload = () => { inv.reload(); lo.reload(); };
  const act = useAction(reload);

  const [side, setSide] = useState<Side>('CT');
  const [target, setTarget] = useState<string | null>(null);
  const [picking, setPicking] = useState<Slot | null>(null);
  const [managing, setManaging] = useState<Slot | null>(null);

  const level = access.data?.level ?? 0;
  useEffect(() => { if (!target && lo.data?.loadouts[0]) setTarget(lo.data.loadouts.find((l) => l.isActive)?.id ?? lo.data.loadouts[0].id); }, [lo.data, target]);
  const current = lo.data?.loadouts.find((l) => l.id === target);
  const equipped = useMemo(() => equippedOf(current), [current]);

  if (!signedIn) return <><PageTitle title="Skin-Changer" /><Card><p className="mb-3 text-sm text-muted">Melde dich an, um deine Skins zu verwalten.</p><Button onClick={() => login('/profile/loadouts')}>Mit Steam anmelden</Button></Card></>;

  /** Sets or clears (item = null) the item of one slot for the given sides, creating the first loadout if there is none. */
  const equip = (slot: Slot, sides: Side[], item: Item | null) => void act.run(async () => {
    let loadout = current;
    if (!loadout) {
      const created = await api<Loadout>('/loadouts', { method: 'POST', body: { name: 'Loadout 1' } });
      loadout = { ...created, items: [] };
      setTarget(created.id);
    }
    const next = equippedOf(loadout);
    for (const s of sides) {
      if (item) next[s][slot.key] = item;
      else delete next[s][slot.key];
    }
    await api(`/loadouts/${loadout.id}/items`, { method: 'PUT', body: { items: rowsOf(next) } });
  });

  const cell = (slot: Slot) => {
    const item = equipped[side][slot.key];
    const rarity = item?.skin?.rarity ? RARITY[item.skin.rarity] : undefined;
    return (
      <div key={slot.key} className="relative">
      {item && <button type="button" onClick={() => void act.run(() => api(`/inventory/${item.id}/favorite`, { method: 'PUT', body: { favorite: !item.favorite } }))} className="absolute right-1.5 top-1.5 z-20 rounded p-1 hover:bg-black/40" aria-label={item.favorite ? 'Favorit entfernen' : 'Dauerhaft im Inventar behalten (Stern)'} title={item.favorite ? 'Favorit – bleibt im Inventar' : 'Stern setzen: dauerhaft im Inventar behalten'}><Star size={15} className={item.favorite ? 'fill-primary text-primary' : 'text-muted'} /></button>}
      <button onClick={() => (item ? setManaging(slot) : setPicking(slot))} className="group relative flex h-24 w-full flex-col justify-between overflow-hidden rounded-md border bg-card p-2 text-left transition hover:bg-card-hover" style={{ borderBottom: `3px solid ${rarity ?? 'var(--border)'}` }} aria-label={item ? `${slot.name} verwalten` : `${slot.name} wählen`}>
        <span className="font-display text-sm font-bold uppercase tracking-wider text-muted">{slot.name}</span>
        {item?.skin?.imageUrl ? <img src={img(item.skin.imageUrl, '192fx144f')} alt="" loading="lazy" referrerPolicy="no-referrer" className="absolute inset-x-0 top-3 mx-auto h-[62px] object-contain transition group-hover:scale-105" /> : <span className="self-center text-xs text-muted/50">Standard</span>}
        {item?.skin && <span className="relative z-10 truncate rounded bg-black/55 px-1 text-[11px] font-semibold text-white">{skinName(item.skin.name, item.skin.phase)}</span>}
      </button>
      </div>
    );
  };

  return (
    <>
      <PageTitle title="Skin-Changer" subtitle="Wähle die Seite, klicke eine Waffe und lege den Skin fest. Waffen für beide Seiten kannst du für T und CT unterschiedlich belegen." actions={
        <div className="rounded-md border bg-card px-3 py-1.5 text-sm">Dein Level <b className="font-display text-lg text-primary">{level}</b>{access.data?.expiresAt && <span className="text-xs text-muted"> · bis {new Date(access.data.expiresAt).toLocaleDateString('de-DE')}</span>}</div>} />
      {act.error && <div className="mb-3"><ErrorBox message={act.error} /></div>}

      <LoadoutBar loadouts={lo.data?.loadouts ?? []} limit={lo.data?.limit ?? 3} target={target} setTarget={setTarget} act={act} loading={lo.loading && !lo.data} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Seite" className="inline-flex overflow-hidden rounded-md border">
          {(['T', 'CT'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)} className={cn('px-5 py-2 font-display text-lg font-extrabold uppercase italic tracking-wider transition', side === s ? (s === 'T' ? 'bg-[#e0a526] text-black' : 'bg-[#5b8def] text-black') : 'bg-card text-muted hover:bg-card-hover')}>
              Equip {s}
            </button>
          ))}
        </div>
        <span className="text-sm text-muted">{side === 'T' ? 'Terroristen' : 'Counter-Terroristen'} · du bearbeitest {current ? `„${current.name}“` : 'dein erstes Loadout'}</span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[140px_1fr]">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-1 lg:content-start">
          {cell(AGENT_SLOT)}
          {cell(GLOVES_SLOT)}
          {cell(KNIFE_SLOT)}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <section key={col.title}>
              <h2 className="mb-2 border-b pb-1 text-xl">{col.title}</h2>
              {col.sections.map((sec) => {
                const slots = sec.slots.filter((sl) => sl.side === 'BOTH' || sl.side === side);
                return (
                  <div key={sec.label} className="mb-3">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{sec.label}</div>
                    <div className="grid gap-2">{slots.map(cell)}</div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>

      {managing && equipped[side][managing.key] && (
        <Manage
          key={`m-${managing.key}-${side}-${equipped[side][managing.key]!.id}`}
          slot={managing}
          side={side}
          item={equipped[side][managing.key]!}
          access={access.data}
          level={level}
          onClose={() => setManaging(null)}
          onPick={() => { setPicking(managing); setManaging(null); }}
          onReset={() => { equip(managing, [side], null); setManaging(null); }}
          onStar={() => { const it = equipped[side][managing.key]!; void act.run(() => api(`/inventory/${it.id}/favorite`, { method: 'PUT', body: { favorite: !it.favorite } })); }}
          onEquip={(sides, item) => { equip(managing, sides, item); setManaging(null); }}
        />
      )}

      {picking && (
        <Picker
          key={`${picking.key}-${side}`}
          slot={picking}
          side={side}
          access={access.data}
          level={level}
          current={equipped[side][picking.key] ?? null}
          favorites={(inv.data?.items ?? []).filter((i) => i.favorite && (picking.key === 'KNIFE' || picking.key === 'GLOVES' || picking.key === 'AGENT' ? i.slot === picking.key : String(i.weaponDefIndex) === picking.key))}
          onClose={() => setPicking(null)}
          onEquip={(sides, item) => { equip(picking, sides, item); setPicking(null); }}
        />
      )}

      <Inventory items={inv.data?.items ?? []} limit={inv.data?.limit} onDelete={(id) => void act.run(() => api(`/inventory/${id}`, { method: 'DELETE' }))} onStar={(id, favorite) => void act.run(() => api(`/inventory/${id}/favorite`, { method: 'PUT', body: { favorite } }))} />
    </>
  );
}

function Inventory({ items, limit, onDelete, onStar }: { items: Item[]; limit?: number; onDelete: (id: string) => void; onStar: (id: string, favorite: boolean) => void }) {
  const shown = items.filter((i) => i.favorite);
  return (
    <details className="mt-10" open>
      <summary className="cursor-pointer font-display text-xl font-bold uppercase tracking-wider">Inventar <span className="text-sm font-normal normal-case text-muted">({shown.length} Favoriten · {items.length}/{limit ?? '–'} gespeichert)</span></summary>
      <p className="mb-3 mt-1 text-sm text-muted">Hier liegen nur Skins mit Stern – sie bleiben dauerhaft erhalten und erscheinen beim Auswählen einer Waffe zum direkten Ausrüsten. Skins ohne Stern gibt es nur, solange sie in einem Loadout stecken. Den Stern setzt du direkt auf der Waffe im Loadout (Stern oben rechts).</p>
      {shown.length === 0 && <p className="mb-3 text-sm text-muted">Noch keine Favoriten.</p>}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((i) => (
          <li key={i.id} className="flex items-center gap-3 rounded-md border bg-card p-2 text-sm">
            {i.skin?.imageUrl && <img src={img(i.skin.imageUrl, '96fx72f')} alt="" referrerPolicy="no-referrer" className="h-12 w-16 object-contain" />}
            <div className="min-w-0 flex-1"><div className="truncate font-medium">{i.skin ? `${i.skin.weaponName} | ${skinName(i.skin.name, i.skin.phase)}` : `Waffe ${i.weaponDefIndex}`}</div><div className="text-xs text-muted">{wearName(i.float)} · {i.float.toFixed(3)} · Pattern {i.pattern}</div></div>
            <Button variant="ghost" aria-label={i.favorite ? 'Favorit entfernen' : 'Als Favorit markieren'} aria-pressed={!!i.favorite} onClick={() => onStar(i.id, !i.favorite)}><Star size={15} className={i.favorite ? 'fill-primary text-primary' : ''} /></Button>
            <Button variant="ghost" aria-label="Item löschen" onClick={() => onDelete(i.id)}><Trash2 size={15} /></Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Manage the item that is equipped in a slot: edit it in place, switch to another skin, reset it or keep it with a star. */
function Manage({ slot, side, item, access, level, onClose, onPick, onReset, onStar, onEquip }: { slot: Slot; side: Side; item: Item; access: Access | undefined; level: number; onClose: () => void; onPick: () => void; onReset: () => void; onStar: () => void; onEquip: (sides: Side[], item: Item) => void }) {
  const detail = useApi<Skin>(item.skin?.id ? `/skins/${item.skin.id}` : null);
  const skin: Skin | null = detail.data ? { ...detail.data, priceMaxUsd: null, requiredLevel: 0 } : null;
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={`${slot.name} verwalten`}>
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-none border bg-elevated sm:rounded-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-2xl">{slot.name} <span className="text-base text-muted">· {side}</span></h2>
            <p className="text-xs text-muted">{item.skin ? `${item.skin.weaponName}${item.slot === 'AGENT' ? '' : ' | ' + skinName(item.skin.name, item.skin.phase)}` : 'Standard'}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="secondary" onClick={onStar} aria-pressed={!!item.favorite} title="Stern: dauerhaft im Inventar behalten"><Star size={14} className={item.favorite ? 'fill-primary text-primary' : ''} />{item.favorite ? 'Favorit' : 'Stern'}</Button>
            <Button variant="ghost" aria-label="Schließen" onClick={onClose}><X size={18} /></Button>
          </div>
        </div>
        <div className="flex gap-2 border-b px-4 py-2">
          <Button onClick={onPick}>Anderen Skin wählen</Button>
          <Button variant="secondary" onClick={onReset}><Trash2 size={14} />Zurücksetzen ({side})</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {skin ? <Editor key={item.id} skin={skin} slot={slot} side={side} access={access} level={level} onEquip={onEquip} existing={item} /> : <Loading />}
        </div>
      </div>
    </div>
  );
}

/** Skin choice + editor for one slot, opened over the grid. */
function Picker({ slot, side, access, level, current, favorites, onClose, onEquip }: { slot: Slot; side: Side; access: Access | undefined; level: number; current: Item | null; favorites: Item[]; onClose: () => void; onEquip: (sides: Side[], item: Item | null) => void }) {
  const isGroup = slot.key === 'KNIFE' || slot.key === 'GLOVES';
  const weapons = useApi<{ weapons: Weapon[] }>(isGroup ? '/skins/weapons' : null);
  const types = (weapons.data?.weapons ?? []).filter((w) => w.slot === slot.key);
  const [type, setType] = useState<number | null>(null);
  const weaponDef = isGroup ? (type ?? types[0]?.weaponDefIndex ?? null) : Number(slot.key);
  const isAgent = slot.key === 'AGENT';
  const skins = useApi<{ skins: Skin[] }>(isAgent ? '/skins?slot=AGENT&pageSize=100' : weaponDef ? `/skins?weaponDefIndex=${weaponDef}&pageSize=100` : null);
  const [filter, setFilter] = useState('');
  const [skin, setSkin] = useState<Skin | null>(null);
  useEffect(() => { setSkin(null); }, [weaponDef]);
  const list = (skins.data?.skins ?? []).filter((s) => !isAgent || s.side === side).filter((s) => !filter || skinName(s.name, s.phase).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-0 sm:p-6" role="dialog" aria-modal="true" aria-label={`${slot.name} Skin wählen`}>
      <div className="flex w-full max-w-6xl flex-col overflow-hidden rounded-none border bg-elevated sm:rounded-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="text-2xl">{slot.name}</h2>
            <p className="text-xs text-muted">Aktuell für {side}: {current ? `${current.skin?.weaponName ?? ''} | ${skinName(current.skin?.name, current.skin?.phase)}` : 'Standard'}</p>
          </div>
          <div className="flex items-center gap-2">
            {current && <Button variant="secondary" onClick={() => onEquip([side], null)}><Trash2 size={14} />Zurücksetzen ({side})</Button>}
            <Button variant="ghost" aria-label="Schließen" onClick={onClose}><X size={18} /></Button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto lg:grid-cols-[1fr_380px] lg:overflow-hidden">
          <div className="min-h-0 overflow-y-auto p-4">
            {isGroup && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {types.map((w) => (
                  <button key={w.weaponDefIndex} onClick={() => setType(w.weaponDefIndex)} aria-pressed={weaponDef === w.weaponDefIndex} className={cn('rounded-md border px-2.5 py-1 text-sm font-medium', weaponDef === w.weaponDefIndex ? 'bg-primary text-primary-fg' : 'bg-card hover:bg-card-hover')}>{w.weaponName}</button>
                ))}
              </div>
            )}
            {favorites.length > 0 && (
              <div className="mb-4">
                <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted"><Star size={12} className="fill-primary text-primary" />Favoriten – ein Klick zum Ausrüsten</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {favorites.map((f) => (
                    <button key={f.id} onClick={() => onEquip(slot.key === 'AGENT' ? [side] : [side], f)} className="flex items-center gap-2 rounded-md border bg-card p-2 text-left hover:bg-card-hover" style={{ borderBottom: `3px solid ${RARITY[f.skin?.rarity ?? ''] ?? '#888'}` }}>
                      {f.skin?.imageUrl && <img src={img(f.skin.imageUrl, '96fx72f')} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-10 w-14 object-contain" />}
                      <span className="min-w-0 text-xs"><span className="block truncate font-semibold">{f.slot === 'AGENT' ? f.skin?.weaponName : skinName(f.skin?.name, f.skin?.phase)}</span><span className="block text-muted">{f.slot === 'AGENT' ? 'Agent' : `${f.float.toFixed(3)} · Pattern ${f.pattern}`}</span></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-3 w-56"><Input aria-label="Skin filtern" placeholder="Skin filtern …" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            {skins.loading && !skins.data ? <Loading /> : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {list.map((s) => {
                  const maybeLocked = s.requiredLevel > level;
                  return (
                    <button key={s.id} onClick={() => setSkin(s)} aria-pressed={skin?.id === s.id} className={cn('overflow-hidden rounded-md border bg-card text-left transition hover:bg-card-hover', skin?.id === s.id && 'ring-2 ring-primary')} style={{ borderBottom: `3px solid ${RARITY[s.rarity ?? ''] ?? '#888'}` }}>
                      <div className="relative flex h-24 items-center justify-center bg-elevated p-2">
                        {s.imageUrl && <img src={img(s.imageUrl)} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />}
                        {maybeLocked && <span title="Das genaue Level hängt von Abnutzung und StatTrak ab (siehe Editor)" className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white"><Lock size={11} />bis Lvl {s.requiredLevel}</span>}
                      </div>
                      <div className="p-2"><div className="truncate text-sm font-semibold">{isAgent ? s.weaponName : skinName(s.name, s.phase)}</div><div className="truncate text-xs text-muted">{s.rarity ?? ''}{s.priceMaxUsd === null ? ' · Preis unbekannt' : ` · bis $${Math.round(s.priceMaxUsd)}`}</div></div>
                    </button>
                  );
                })}
                {list.length === 0 && !skins.loading && <p className="col-span-full text-sm text-muted">Keine Skins gefunden. Hat ein Admin den Katalog synchronisiert?</p>}
              </div>
            )}
          </div>
          <aside className="min-h-0 overflow-y-auto border-t p-4 lg:border-l lg:border-t-0">
            {skin ? <Editor key={skin.id} skin={skin} slot={slot} side={side} access={access} level={level} onEquip={onEquip} /> : <p className="text-sm text-muted">Wähle links einen Skin. Hier stellst du dann Float, Pattern, StatTrak und Sticker ein.</p>}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Editor({ skin, slot, side, access, level, onEquip, existing }: { skin: Skin; slot: Slot; side: Side; access: Access | undefined; level: number; onEquip: (sides: Side[], item: Item) => void; existing?: Item }) {
  const canFloat = !!access?.floatEditing;
  const [float, setFloat] = useState(existing ? existing.float : Math.max(skin.minFloat, Math.min(skin.maxFloat, 0.07)));
  const [pattern, setPattern] = useState(existing ? String(existing.pattern) : '1');
  const [statTrak, setStatTrak] = useState(existing?.statTrak ?? false);
  const [nameTag, setNameTag] = useState(existing?.nameTag ?? '');
  const [stickers, setStickers] = useState<Array<PlacedSticker | null>>(() => {
    const slots: Array<PlacedSticker | null> = Array(STICKER_SLOTS).fill(null);
    for (const s of existing?.stickers ?? []) if (s.slotIndex >= 0 && s.slotIndex < STICKER_SLOTS) slots[s.slotIndex] = { sticker: s.sticker, wear: s.wear, rotation: s.rotation ?? 0, scale: s.scale ?? 1 };
    return slots;
  });
  const [pickSlot, setPickSlot] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'SIDE' | 'BOTH'>('SIDE');
  const isAgent = skin.slot === 'AGENT';
  const [charm, setCharm] = useState<Charm | null>(existing?.keychain ?? null);
  const [charmSeed, setCharmSeed] = useState(String(existing?.keychainSeed ?? 0));
  const [savedPos, setSavedPos] = useState<Pos | null>(null);
  const [charmPos, setCharmPos] = useState<Pos>({ x: existing?.keychainOffsetX ?? 0, y: existing?.keychainOffsetY ?? 0, z: existing?.keychainOffsetZ ?? 0 });
  // a new charm starts where the player last saved their favourite position
  useEffect(() => { const p = loadSavedPos(); setSavedPos(p); if (p && !existing?.keychain) setCharmPos(p); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const charms = useApi<{ keychains: Charm[] }>(!isAgent && skin.slot !== 'KNIFE' && skin.slot !== 'GLOVES' ? '/keychains?pageSize=100' : null);
  const found = useApi<{ stickers: Sticker[] }>(pickSlot !== null && q.length >= 2 ? `/stickers?q=${encodeURIComponent(q)}&pageSize=12` : null);
  const detail = useApi<{ prices: PriceEntry[] }>(`/skins/${skin.id}`);
  const act = useAction();

  const usedFloat = isAgent ? 0.001 : canFloat ? float : 0.07;
  const variant = statTrak && skin.statTrakAvailable ? 'STATTRAK' : 'NORMAL';
  const entry = detail.data?.prices.find((p) => (isAgent ? p.wear === 'NONE' : p.wear === wearEnum(usedFloat)) && p.variant === variant);
  const needed = detail.data ? (entry?.requiredLevel ?? 3) : skin.requiredLevel;
  const locked = needed > level;
  const patternValid = /^\d{1,4}$/.test(pattern) && Number(pattern) <= 1000;
  const canStickers = skin.slot !== 'KNIFE' && skin.slot !== 'GLOVES' && !isAgent;

  const save = () => void act.run(async () => {
    const created = await api<Item>(existing ? `/inventory/${existing.id}` : '/inventory', {
      method: existing ? 'PUT' : 'POST',
      body: {
        slot: skin.slot, weaponDefIndex: skin.weaponDefIndex, skinId: skin.id, floatValue: usedFloat, paintSeed: Number(pattern),
        statTrak: statTrak && skin.statTrakAvailable, nameTag: nameTag || null,
        keychainId: charm?.id ?? null, keychainSeed: Number(charmSeed) || 0, keychainOffsetX: charmPos.x, keychainOffsetY: charmPos.y, keychainOffsetZ: charmPos.z,
        stickers: stickers.flatMap((s, i) => (s ? [{ stickerId: s.sticker.id, slotIndex: i, wear: s.wear, rotation: s.rotation, scale: s.scale }] : [])),
      },
    });
    const item: Item = { ...created, skin: { name: isAgent ? skin.weaponName : skin.name, phase: skin.phase, weaponName: skin.weaponName, imageUrl: skin.imageUrl, rarity: skin.rarity }, float: usedFloat, pattern: Number(pattern), statTrak, statTrakCount: 0, nameTag: nameTag || null, slot: skin.slot, weaponDefIndex: skin.weaponDefIndex };
    onEquip(scope === 'BOTH' && !isAgent ? ['T', 'CT'] : [side], item);
  });

  return (
    <div className="space-y-4">
      <div className="flex h-36 items-center justify-center rounded-md bg-card p-2" style={{ borderBottom: `3px solid ${RARITY[skin.rarity ?? ''] ?? '#888'}` }}>
        {skin.imageUrl && <img src={img(skin.imageUrl, '360fx270f')} alt={`${skin.weaponName} | ${skinName(skin.name, skin.phase)}`} referrerPolicy="no-referrer" className="max-h-full object-contain" />}
      </div>
      <div>
        <h3 className="text-xl">{isAgent ? skin.weaponName : `${skin.weaponName} | ${skinName(skin.name, skin.phase)}`}</h3>
        <p className="text-xs text-muted">{skin.rarity} · {entry ? `${isAgent ? 'Agent' : wearName(usedFloat)}${variant === 'STATTRAK' ? ' StatTrak' : ''}: ca. ${Math.round(entry.priceUsd)} → Level ${needed}` : detail.data ? `kein Marktpreis für diese Variante → Level ${needed}` : 'Preis wird geladen …'}</p>
      </div>

      {!isAgent && <div>
        <div className="mb-1 flex justify-between text-sm"><span className="text-muted">Float</span><span className="font-mono">{float.toFixed(4)} · {wearName(float)}</span></div>
        <input type="range" aria-label="Float" min={skin.minFloat} max={skin.maxFloat} step={0.0005} value={float} disabled={!canFloat} onChange={(e) => setFloat(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
        {!canFloat && <p className="text-xs text-muted">Float-Bearbeitung ist für dich nicht freigeschaltet (Standardwert).</p>}
      </div>}

      {!isAgent && <div>
        <div className="flex items-end gap-2">
          <Input label="Pattern (ganze Zahl 0–1000)" inputMode="numeric" value={pattern} aria-invalid={!patternValid} onChange={(e) => setPattern(e.target.value.replace(/[^\d]/g, ''))} />
          <Button variant="secondary" type="button" onClick={() => setPattern(String(Math.floor(Math.random() * 1001)))}>Zufall</Button>
        </div>
        {!patternValid && <p className="mt-1 text-xs text-danger">Das Pattern muss eine ganze Zahl von 0 bis 1000 sein.</p>}
      </div>}

      {skin.statTrakAvailable && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={statTrak} onChange={(e) => setStatTrak(e.target.checked)} />StatTrak™</label>}
      {canStickers && <Input label={`Name-Tag (max. ${NAME_TAG_MAX})`} maxLength={NAME_TAG_MAX} value={nameTag} onChange={(e) => setNameTag(e.target.value)} />}

      {canStickers && (
        <div>
          <div className="mb-1 text-sm text-muted">Sticker</div>
          <div className="grid grid-cols-5 gap-1.5">
            {stickers.map((s, i) => (
              <button key={i} type="button" onClick={() => setPickSlot(pickSlot === i ? null : i)} aria-label={`Sticker-Slot ${i + 1}`} className={cn('flex h-12 items-center justify-center rounded-md border bg-card', pickSlot === i && 'ring-2 ring-primary')}>
                {s?.sticker.imageUrl ? <img src={img(s.sticker.imageUrl, '64fx48f')} alt={s.sticker.name} referrerPolicy="no-referrer" className="max-h-full" /> : <Plus size={14} className="text-muted" />}
              </button>
            ))}
          </div>
          {pickSlot !== null && (
            <div className="mt-2 space-y-2">
              <Input aria-label="Sticker suchen" placeholder="Sticker suchen (min. 2 Zeichen) …" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="max-h-40 overflow-y-auto rounded-md border">
                {found.data?.stickers.map((s) => (
                  <button key={s.id} type="button" className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-card-hover" onClick={() => { setStickers(stickers.map((x, i) => (i === pickSlot ? { sticker: s, wear: 0, rotation: 0, scale: 1 } : x))); setQ(''); }}>
                    {s.imageUrl && <img src={img(s.imageUrl, '48fx36f')} alt="" referrerPolicy="no-referrer" className="h-6" />}<span className="truncate">{s.name}</span>
                  </button>
                ))}
                {stickers[pickSlot] && <button type="button" className="w-full px-2 py-1 text-left text-sm text-danger hover:bg-card-hover" onClick={() => { setStickers(stickers.map((x, i) => (i === pickSlot ? null : x))); setPickSlot(null); }}>Sticker entfernen</button>}
              </div>
              {stickers[pickSlot] && (
                <div className="space-y-1 rounded-md border p-2 text-xs">
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
      )}

      {charms.data && charms.data.keychains.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between text-sm"><span className="text-muted">Charm</span>{charm && <button type="button" className="text-xs text-danger" onClick={() => setCharm(null)}>entfernen</button>}</div>
          <div className="grid max-h-32 grid-cols-4 gap-1.5 overflow-y-auto">
            {charms.data.keychains.map((c) => (
              <button key={c.id} type="button" title={c.name} aria-pressed={charm?.id === c.id} onClick={() => setCharm(c)} className={cn('flex h-14 items-center justify-center rounded-md border bg-card p-1', charm?.id === c.id && 'ring-2 ring-primary')}>
                {c.imageUrl ? <img src={img(c.imageUrl, '96fx72f')} alt={c.name} loading="lazy" referrerPolicy="no-referrer" className="max-h-full object-contain" /> : <span className="text-[10px]">{c.name}</span>}
              </button>
            ))}
          </div>
          {charm && (
            <div className="mt-2 space-y-1 rounded-md border p-2 text-xs">
              <div className="text-muted">Position des Charms an der Waffe</div>
              <div className="flex flex-wrap gap-1">
                {CHARM_PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => setCharmPos(p.pos)} className={cn('rounded border px-2 py-0.5 hover:bg-card-hover', charmPos.x === p.pos.x && charmPos.y === p.pos.y && charmPos.z === p.pos.z && 'border-primary bg-primary/15 text-primary')}>{p.label}</button>
                ))}
                {savedPos && <button type="button" onClick={() => setCharmPos(savedPos)} className="rounded border px-2 py-0.5 hover:bg-card-hover">Meine Position</button>}
              </div>
              {(['x', 'y', 'z'] as const).map((axis) => (
                <label key={axis} className="flex items-center gap-2"><span className="w-6 uppercase text-muted">{axis}</span><input type="range" min={-10} max={10} step={0.1} value={charmPos[axis]} onChange={(e) => setCharmPos({ ...charmPos, [axis]: Number(e.target.value) })} className="flex-1 accent-[var(--primary)]" /><span className="w-10 text-right font-mono">{charmPos[axis].toFixed(1)}</span></label>
              ))}
              <button type="button" className="rounded border px-2 py-0.5 hover:bg-card-hover" onClick={() => { try { localStorage.setItem(SAVED_POS_KEY, JSON.stringify(charmPos)); } catch { /* storage may be blocked */ } setSavedPos(charmPos); }}>Als meine Standard-Position merken</button>
            </div>
          )}
          {charm && <div className="mt-1 flex items-end gap-2"><span className="flex-1 truncate text-xs text-muted">{charm.name}</span><div className="w-28"><Input label="Charm-Muster" inputMode="numeric" value={charmSeed} onChange={(e) => setCharmSeed(e.target.value.replace(/[^\d]/g, '').slice(0, 5))} /></div></div>}
        </div>
      )}

      {!isAgent && <fieldset className="rounded-md border p-2">
        <legend className="px-1 text-xs uppercase tracking-wider text-muted">Gilt für</legend>
        <div className="flex gap-2">
          {([['SIDE', `Nur ${side}`], ['BOTH', 'Beide Seiten (T + CT)']] as const).map(([value, label]) => (
            <label key={value} className={cn('flex flex-1 cursor-pointer items-center justify-center rounded-md border px-2 py-1.5 text-center text-sm font-semibold', scope === value ? 'border-primary bg-primary/15 text-primary' : 'hover:bg-card-hover')}>
              <input type="radio" name="scope" className="sr-only" checked={scope === value} onChange={() => setScope(value)} />{label}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{slot.name}: Mit „Nur {side}“ kann die andere Seite einen anderen Skin tragen.</p>
      </fieldset>}
      {isAgent && <p className="text-xs text-muted">Agenten gelten nur für ihre eigene Seite ({side}). Das Modell wird beim Spawn gesetzt.</p>}

      {locked && <p className="flex items-center gap-1.5 rounded-md bg-warning/15 p-2 text-sm text-warning"><Lock size={14} />Diese Variante braucht Level {needed} (du hast {level}). Eine stärkere Abnutzung oder ohne StatTrak ist oft günstiger.</p>}
      {act.error && <ErrorBox message={act.error} />}
      <Button className="w-full" disabled={locked || (!isAgent && !patternValid) || act.busy} onClick={save}>{existing ? 'Änderungen speichern' : 'Ausrüsten'}</Button>
    </div>
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
          <button key={l.id} onClick={() => setTarget(l.id)} aria-pressed={target === l.id} className={cn('rounded-md border bg-card p-3 text-left transition hover:bg-card-hover', target === l.id && 'ring-2 ring-primary')}>
            <div className="flex items-center justify-between"><b className="font-display text-lg uppercase tracking-wide">{l.name}</b><span className="flex flex-wrap items-center justify-end gap-1 text-xs text-success">{l.isActive && <span className="flex items-center gap-1"><Check size={12} />aktiv</span>}{l.activeT && <span className="rounded bg-[#e0a526] px-1.5 font-bold text-black">T</span>}{l.activeCt && <span className="rounded bg-[#5b8def] px-1.5 font-bold text-black">CT</span>}</span></div>
            <div className="mt-0.5 text-xs text-muted">{l.items.length} Einträge{l.shareCode ? ` · ${l.shareCode}` : ''}</div>
            {target === l.id && (
              <div className="mt-2 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
                {!l.isActive && <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act.run(() => api(`/loadouts/${l.id}/activate`, { method: 'POST' }))}>Aktivieren</Button>}
                <Button variant={l.activeT ? 'primary' : 'secondary'} className="px-2 py-1 text-xs" title="Dieses Loadout gilt auf der T-Seite (überschreibt das aktive)" onClick={() => void act.run(() => api(`/loadouts/${l.id}/side`, { method: 'PUT', body: { side: 'T', active: !l.activeT } }))}>{l.activeT ? 'T ✓' : 'Für T'}</Button>
                <Button variant={l.activeCt ? 'primary' : 'secondary'} className="px-2 py-1 text-xs" title="Dieses Loadout gilt auf der CT-Seite (überschreibt das aktive)" onClick={() => void act.run(() => api(`/loadouts/${l.id}/side`, { method: 'PUT', body: { side: 'CT', active: !l.activeCt } }))}>{l.activeCt ? 'CT ✓' : 'Für CT'}</Button>
                <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act.run(() => api(`/loadouts/${l.id}/share-code`, { method: 'POST' }))}><Share2 size={12} />Code</Button>
                <Button variant="secondary" className="px-2 py-1 text-xs" title="Nur das aktive Loadout erscheint auf deinem Profil" onClick={() => void act.run(() => api(`/loadouts/${l.id}`, { method: 'PATCH', body: { visibility: l.visibility === 'PRIVATE' ? 'PUBLIC' : 'PRIVATE' } }))}>{l.visibility === 'PRIVATE' ? 'Privat' : 'Öffentlich'}</Button>
                <Button variant="ghost" className="px-2 py-1 text-xs" aria-label="Loadout löschen" onClick={() => { if (confirm(`Loadout „${l.name}“ löschen?`)) void act.run(() => api(`/loadouts/${l.id}`, { method: 'DELETE' })); }}><Trash2 size={12} /></Button>
              </div>
            )}
          </button>
        ))}
        {loadouts.length < limit && (
          <form className="flex items-end gap-2 rounded-md border border-dashed p-3" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api('/loadouts', { method: 'POST', body: { name } }); setName(''); }); }}>
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
