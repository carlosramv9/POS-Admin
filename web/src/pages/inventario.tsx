import { useState, useMemo, useRef } from 'react'
import { DataTable, Pagination, type Column } from '@/components/shared/data-table'
import { CategoryFormModal } from '@/components/inventario/category-form-modal'
import { ProductFormModal } from '@/components/inventario/product-form-modal'
import { AiProductAssistDialog } from '@/components/inventario/ai-product-assist-dialog'
import { Search, Plus, Pencil, Trash2, Loader2, Package, Tag, Download, Upload, X, CircleCheck, TriangleAlert, Sparkles } from 'lucide-react'
import { useProducts } from '@/hooks/retail/use-products'
import { useCategories } from '@/hooks/retail/use-categories'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Product } from '@/services/retail/product-service'
import type { ProductDraftResponse } from '@/services/retail/product-ai-service'
import type { Category } from '@/hooks/retail/use-categories'

const DRAFT_TAX_RATE: Record<string, number> = { IVA_16: 16, IVA_11: 11, IVA_8: 8, EXCENTO: 0 }

const PER_PAGE = 7

// ── Shared helpers ──────────────────────────────────────────────────────────

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20">
      <span className="text-sm text-red-500">{message}</span>
      <button onClick={onRetry} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm cursor-pointer">
        Reintentar
      </button>
    </div>
  )
}

// ── Categorías: column definitions (static — defined outside component) ─────

const STATUS_CAT_BADGE: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  INACTIVE: 'bg-gray-100 text-gray-500',
}

// ── Main component ───────────────────────────────────────────────────────────

export function Inventario() {
  const [activeTab, setActiveTab] = useState<'productos' | 'categorias'>('productos')

  // ── Products ──
  const {
    loading: prodLoading, error: prodError, search, setSearch,
    catFilter, setCatFilter, page, setPage, modalOpen, editingId,
    form, setForm, filtered, pageData, stats,
    handleSave, handleEdit, handleDelete, handleOpenNew, handleOpenWithDraft, handleCloseModal, loadProducts,
    importing, importResult, importError, handleDownloadTemplate, handleImportFile, clearImportResult,
  } = useProducts()

  const [aiDialogOpen, setAiDialogOpen] = useState(false)

  const handleUseDraft = (draft: ProductDraftResponse) => {
    handleOpenWithDraft({
      name: draft.name,
      description: draft.description ?? '',
      price: draft.price,
      // comparePrice/trackInventory/lowStockAlert: si el borrador no trae
      // señal (null), se omiten del patch y EMPTY_FORM aporta el default
      // del tenant — igual que hace el reconciliador en el backend (§08).
      ...(draft.comparePrice != null ? { comparePrice: draft.comparePrice } : {}),
      costPrice: draft.costPrice ?? 0,
      categoryId: draft.category.id ?? '',
      taxCode: draft.taxCode,
      taxRate: DRAFT_TAX_RATE[draft.taxCode] ?? 0,
      sku: draft.skuSuggestion,
      ...(draft.trackInventory != null ? { trackInventory: draft.trackInventory } : {}),
      ...(draft.lowStockAlert != null ? { lowStockAlert: draft.lowStockAlert } : {}),
      aiRequestId: draft.aiRequestId,
    })
  }

  const importInputRef = useRef<HTMLInputElement>(null)

  const onImportFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleImportFile(file)
    e.target.value = ''
  }

  // ── Categories ──
  const {
    categories, loading: catLoading, error: catError,
    search: catSearch, setSearch: setCatSearch,
    page: catPage, setPage: setCatPage,
    modalOpen: catModalOpen, editingId: catEditingId,
    form: catForm, setForm: setCatForm, setName: setCatName,
    filtered: catFiltered, pageData: catPageData,
    stats: catStats, perPage: catPerPage,
    handleSave: handleCatSave, handleEdit: handleCatEdit,
    handleDelete: handleCatDelete, handleOpenNew: handleCatOpenNew,
    handleCloseModal: handleCatCloseModal, loadCategories,
  } = useCategories()

  const TYPE_BADGE: Record<string, { label: string; cls: string }> = {
    SIMPLE:  { label: 'Simple',   cls: 'bg-gray-100 text-gray-600' },
    RECIPE:  { label: 'Receta',   cls: 'bg-orange-100 text-orange-700' },
    COMBO:   { label: 'Combo',    cls: 'bg-purple-100 text-purple-700' },
    SERVICE: { label: 'Servicio', cls: 'bg-blue-100 text-blue-700' },
  }

  // ── Product columns ───────────────────────────────────────────────────────
  const prodColumns: Column<Product>[] = useMemo(() => [
    { label: "SKU", render: r => <span className="font-mono text-[11px] text-muted-foreground font-semibold">{r.sku}</span> },
    {
      label: "Producto", render: r => (
        <div>
          <div className="font-semibold text-[13px] text-foreground">{r.name}</div>
          <div className="text-[11px] text-muted-foreground">{r.description}</div>
        </div>
      )
    },
    {
      label: "Tipo", render: r => {
        const t = TYPE_BADGE[r.type ?? 'SIMPLE'] ?? TYPE_BADGE.SIMPLE
        return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${t.cls}`}>{t.label}</span>
      }
    },
    {
      label: "Stock", align: "center", render: r => {
        if (r.type !== 'SIMPLE' && r.type != null) {
          return <span className="text-[10px] text-muted-foreground italic">N/A</span>
        }
        const pct = r.trackInventory ? Math.min((r.stock / (r.lowStockAlert * 4)) * 100, 100) : 100
        const color = !r.trackInventory ? "#16a34a" : r.stock > r.lowStockAlert ? "#16a34a" : r.stock > 0 ? "#d97706" : "#dc2626"
        // Con presentaciones, el número de arriba es la SUMA de todas. Se
        // desglosa: es lo que se repone y lo que se cuenta, y un total agregado
        // no dice de cuál falta.
        const presentaciones = (r.variants ?? []).filter(v => !v.isDefault && (v.name ?? '').trim() !== '')
        return (
          <div className="flex flex-col items-center gap-1">
            <span className="font-bold text-sm" style={{ color }}>{r.stock}</span>
            {r.trackInventory && (
              <>
                <div className="w-15 h-1 bg-muted rounded-full">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                </div>
                <span className="text-[10px] text-muted-foreground">mín: {r.lowStockAlert}</span>
              </>
            )}
            {presentaciones.length > 0 && (
              <div className="flex flex-col items-center gap-0.5 mt-0.5">
                {presentaciones.map(v => (
                  <span key={v.id ?? v.name} className="text-[10px] text-muted-foreground leading-tight">
                    {v.name}: <span className="font-semibold text-foreground">{v.stock ?? 0}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      }
    },
    {
      label: "Estado", render: r => (
        <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${r.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
            r.status === 'DRAFT' ? 'bg-gray-100 text-gray-700' : 'bg-red-100 text-red-700'
          }`}>
          {r.status === 'ACTIVE' ? 'Activo' : r.status === 'DRAFT' ? 'Borrador' : 'Archivado'}
        </span>
      )
    },
    { label: "Precio", align: "right", render: r => <span className="font-bold text-foreground text-[13px]">${Number(r.price || 0).toFixed(2)}</span> },
    { label: "Costo", align: "right", render: r => <span className="text-muted-foreground text-[13px]">${Number(r.costPrice || 0).toFixed(2)}</span> },
    {
      label: "Margen", align: "right", render: r => {
        const m = Number(r.price || 0) > 0 ? Math.round(((Number(r.price || 0) - Number(r.costPrice || 0)) / Number(r.price || 0)) * 100) : 0
        return <span className={`font-semibold text-xs ${m > 30 ? 'text-green-600' : m > 15 ? 'text-amber-600' : 'text-red-600'}`}>{m}%</span>
      }
    },
    {
      label: "Acciones", render: r => (
        <div className="flex gap-1">
          <button onClick={() => handleEdit(r)} className="p-1.5 hover:bg-muted rounded cursor-pointer">
            <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button onClick={() => handleDelete(r.id!)} className="p-1.5 hover:bg-muted rounded cursor-pointer">
            <Trash2 className="w-3.5 h-3.5 text-red-500" />
          </button>
        </div>
      )
    },
  ], [handleEdit, handleDelete])

  // ── Category columns ──────────────────────────────────────────────────────
  const catColumns: Column<Category>[] = useMemo(() => {
    const parentName = (id: string | null) => categories.find(c => c.id === id)?.name ?? '—'
    return [
      {
        label: "Categoría", render: r => (
          <div>
            <div className="font-semibold text-[13px] text-foreground">{r.name}</div>
            <div className="text-[11px] font-mono text-muted-foreground">{r.slug}</div>
          </div>
        )
      },
      { label: "Descripción", render: r => <span className="text-xs text-muted-foreground max-w-[200px] overflow-hidden text-ellipsis block">{r.description || '—'}</span> },
      { label: "Padre", render: r => <span className="text-xs text-muted-foreground">{parentName(r.parentId)}</span> },
      {
        label: "Estado", render: r => (
          <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${STATUS_CAT_BADGE[r.status]}`}>
            {r.status === 'ACTIVE' ? 'Activa' : 'Inactiva'}
          </span>
        )
      },
      { label: "Orden", align: "center", render: r => <span className="text-xs font-semibold text-muted-foreground">{r.sortOrder}</span> },
      {
        label: "Acciones", render: r => (
          <div className="flex gap-1">
            <button onClick={() => handleCatEdit(r)} className="p-1.5 hover:bg-muted rounded cursor-pointer">
              <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button onClick={() => handleCatDelete(r.id!)} className="p-1.5 hover:bg-muted rounded cursor-pointer">
              <Trash2 className="w-3.5 h-3.5 text-red-500" />
            </button>
          </div>
        )
      },
    ]
  }, [categories, handleCatEdit, handleCatDelete])

  return (
    <div className="p-7 flex flex-col gap-5">

      {/* Tab switcher */}
      <div className="flex gap-0.5 bg-muted rounded-lg p-0.5 w-fit">
        {([
          { id: 'productos', label: 'Productos', icon: Package },
          { id: 'categorias', label: 'Categorías', icon: Tag },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-1.5 border-none rounded-md text-xs font-semibold cursor-pointer transition-all
              ${activeTab === id ? 'bg-card text-foreground shadow-sm' : 'bg-transparent text-muted-foreground'}`}>
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── PRODUCTOS TAB ───────────────────────────────────────────────── */}
      {activeTab === 'productos' && (
        prodLoading ? <LoadingState label="Cargando productos..." /> :
          prodError ? <ErrorState message={prodError} onRetry={loadProducts} /> :
            <>
              <div className="flex gap-3.5">
                {[
                  { label: "Total Productos", value: stats.total, color: "text-primary" },
                  { label: "Stock OK", value: stats.ok, color: "text-green-600" },
                  { label: "Stock Bajo", value: stats.bajo, color: "text-amber-600" },
                  { label: "Agotados", value: stats.agotado, color: "text-red-600" },
                ].map((s, i) => (
                  <div key={i} className="flex-1 bg-card border border-border rounded-[10px] px-4.5 py-3.5">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">{s.label}</div>
                    <div className={`text-[28px] font-extrabold ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>

              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3.5 border-b border-border gap-3">
                  <label className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">Categoría</span>
                    <Select value={catFilter} onValueChange={v => { if (v) { setCatFilter(v); setPage(1) } }}>
                      <SelectTrigger size="sm" className="min-w-[160px]">
                        <SelectValue>
                          {catFilter === "Todas"
                            ? "Todas las categorías"
                            : (categories.find(c => c.id === catFilter)?.name ?? catFilter)}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectItem value="Todas">Todas las categorías</SelectItem>
                        {categories.filter(c => c.status === 'ACTIVE').map(c => (
                          <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="flex gap-2.5 items-center">
                    <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5">
                      <Search className="w-3.5 h-3.5 text-muted-foreground" />
                      <input value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} placeholder="Buscar producto…"
                        className="border-none bg-transparent outline-none text-xs text-foreground w-40" />
                    </div>
                    <button onClick={handleDownloadTemplate} className="flex items-center gap-1.5 px-3.5 py-1.5 bg-card border border-border text-foreground rounded-lg text-xs font-semibold cursor-pointer">
                      <Download className="w-3.5 h-3.5" /> Plantilla
                    </button>
                    <button onClick={() => importInputRef.current?.click()} disabled={importing} className="flex items-center gap-1.5 px-3.5 py-1.5 bg-card border border-border text-foreground rounded-lg text-xs font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                      {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      {importing ? 'Importando…' : 'Importar Excel'}
                    </button>
                    <input ref={importInputRef} type="file" accept=".xlsx" className="hidden" onChange={onImportFileSelected} />
                    <button onClick={() => setAiDialogOpen(true)} className="flex items-center gap-1.5 px-3.5 py-1.5 bg-card border border-primary/40 text-primary rounded-lg text-xs font-semibold cursor-pointer">
                      <Sparkles className="w-3.5 h-3.5" /> Alta con IA
                    </button>
                    <button onClick={handleOpenNew} className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-primary-foreground border-none rounded-lg text-xs font-semibold cursor-pointer">
                      <Plus className="w-3.5 h-3.5" /> Nuevo Producto
                    </button>
                  </div>
                </div>
                {(importResult || importError) && (
                  <div className={`mx-4 mt-3.5 rounded-lg border px-4 py-3 flex items-start gap-2.5 ${importError ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                    {importError ? (
                      <TriangleAlert className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                    ) : (
                      <CircleCheck className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                    )}
                    <div className="flex-1 text-xs">
                      {importError ? (
                        <p className="text-red-700 font-medium">{importError}</p>
                      ) : (
                        <>
                          <p className="text-green-700 font-medium">
                            {importResult!.totalRows} filas procesadas · {importResult!.created} creados · {importResult!.updated} actualizados
                            {importResult!.errors.length > 0 && ` · ${importResult!.errors.length} con errores`}
                          </p>
                          {importResult!.errors.length > 0 && (
                            <ul className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                              {importResult!.errors.slice(0, 20).map((err, i) => (
                                <li key={i} className="text-amber-700">
                                  Fila {err.row}{err.sku ? ` (${err.sku})` : ''}: {err.message}
                                </li>
                              ))}
                              {importResult!.errors.length > 20 && (
                                <li className="text-muted-foreground">…y {importResult!.errors.length - 20} más</li>
                              )}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                    <button onClick={clearImportResult} className="p-1 hover:bg-black/5 rounded cursor-pointer shrink-0">
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                )}
                {filtered.length === 0 ? (
                  <div className="p-12 text-center">
                    <p className="text-muted-foreground text-sm">No se encontraron productos</p>
                  </div>
                ) : (
                  <>
                    <DataTable columns={prodColumns} rows={pageData} />
                    <Pagination page={page} total={filtered.length} perPage={PER_PAGE} onChange={setPage} />
                  </>
                )}
              </div>
            </>
      )}

      {/* ── CATEGORÍAS TAB ─────────────────────────────────────────────── */}
      {activeTab === 'categorias' && (
        catLoading ? <LoadingState label="Cargando categorías..." /> :
          catError ? <ErrorState message={catError} onRetry={loadCategories} /> :
            <>
              <div className="flex gap-3.5">
                {[
                  { label: "Total Categorías", value: catStats.total, color: "text-primary" },
                  { label: "Activas", value: catStats.active, color: "text-green-600" },
                  { label: "Inactivas", value: catStats.inactive, color: "text-gray-500" },
                ].map((s, i) => (
                  <div key={i} className="flex-1 bg-card border border-border rounded-[10px] px-4.5 py-3.5">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">{s.label}</div>
                    <div className={`text-[28px] font-extrabold ${s.color}`}>{s.value}</div>
                  </div>
                ))}
              </div>

              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3.5 border-b border-border gap-3">
                  <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5">
                    <Search className="w-3.5 h-3.5 text-muted-foreground" />
                    <input value={catSearch} onChange={e => { setCatSearch(e.target.value); setCatPage(1) }} placeholder="Buscar categoría…"
                      className="border-none bg-transparent outline-none text-xs text-foreground w-44" />
                  </div>
                  <button onClick={handleCatOpenNew} className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-primary-foreground border-none rounded-lg text-xs font-semibold cursor-pointer">
                    <Plus className="w-3.5 h-3.5" /> Nueva Categoría
                  </button>
                </div>
                {catFiltered.length === 0 ? (
                  <div className="p-12 text-center">
                    <p className="text-muted-foreground text-sm">No se encontraron categorías</p>
                  </div>
                ) : (
                  <>
                    <DataTable columns={catColumns} rows={catPageData} />
                    <Pagination page={catPage} total={catFiltered.length} perPage={catPerPage} onChange={setCatPage} />
                  </>
                )}
              </div>
            </>
      )}

      <ProductFormModal
        open={modalOpen}
        onClose={handleCloseModal}
        editingId={editingId}
        form={form}
        setForm={setForm}
        onSave={handleSave}
        onImageChange={loadProducts}
        categories={categories}
      />

      <AiProductAssistDialog
        open={aiDialogOpen}
        onClose={() => setAiDialogOpen(false)}
        onUseDraft={handleUseDraft}
      />

      <CategoryFormModal
        open={catModalOpen}
        onClose={handleCatCloseModal}
        editingId={catEditingId}
        form={catForm}
        setForm={setCatForm}
        setName={setCatName}
        categories={categories}
        onSave={handleCatSave}
      />

    </div>
  )
}
