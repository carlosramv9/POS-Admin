import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface FormModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function FormModal({ open, onClose, title, children }: FormModalProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-[520px] max-h-[90vh] flex flex-col overflow-hidden p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface FormFieldProps {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  options?: string[]
  error?: string
  step?: number | string
  min?: number | string
  max?: number | string
  /** Muestra el valor sin permitir editarlo (el dato se cambia en otro flujo). */
  readOnly?: boolean
  /** Nota bajo el campo. Para explicar por qué es de solo lectura, por ejemplo. */
  hint?: string
}

export function FormField({ label, type = "text", value, onChange, options, error, step, min, max, readOnly, hint }: FormFieldProps) {
  const inputCls = `w-full px-2.5 py-2 border rounded-lg text-[13px] text-foreground outline-none focus:border-primary ${
    error ? 'border-red-400 focus:border-red-400' : 'border-border'
  } ${readOnly ? 'bg-muted text-muted-foreground cursor-not-allowed' : 'bg-card'}`
  return (
    <div className="mb-3.5">
      <label className="block text-xs font-semibold text-muted-foreground mb-1.5">{label}</label>
      {options ? (
        <select value={value} onChange={e => onChange(e.target.value)} className={inputCls} disabled={readOnly}>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} className={inputCls} step={step} min={min} max={max} readOnly={readOnly} />
      )}
      {error && <p className="text-[11px] text-red-500 mt-1 leading-tight">{error}</p>}
      {!error && hint && <p className="text-[11px] text-muted-foreground mt-1 leading-tight">{hint}</p>}
    </div>
  )
}
