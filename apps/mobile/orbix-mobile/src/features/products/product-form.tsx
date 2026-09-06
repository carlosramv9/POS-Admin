/**
 * Create/edit form, shared by `(app)/products/new.tsx` and `(app)/products/[id].tsx`.
 *
 * Works across every business vertical: `type` decides which fields matter —
 * stock/inventory only applies to SIMPLE, RECIPE is offered only when the
 * tenant's business config enables it (`enableRecipes`, restaurant-only, mirrors
 * the server-side gate in `ProductsService.assertRecipesEnabled`). COMBO/RECIPE
 * item editing (ingredients, bundled products) is out of scope here — this
 * screen owns the base product record only.
 *
 * Wizard, not one long scroll: the five sections below (`STEP_IDS`) map 1:1 to
 * the pre-existing `products.section*` i18n labels, each gated by the fields
 * that actually belong to it.
 *
 * Two navigation modes, picked by `isEditing`:
 * - Create (`isEditing` false): guided — `trigger()` validates only the
 *   current step's fields before advancing via "Continuar", Guardar only
 *   appears on the last step. A blank record benefits from being walked
 *   through in order.
 * - Edit (`isEditing` true): free — a row of labelled, tappable tabs jumps
 *   straight to any step (1→4 in one tap), no per-step validation gate, and
 *   Guardar is available from every step. An existing record is already
 *   complete; forcing a full replay of the wizard to fix one field would be
 *   the opposite of "cleaner screen". Whole-record validation still runs on
 *   submit either way (`zodResolver`), so this can't save invalid data.
 */
import { useMemo, useState } from 'react';
import { useFieldArray, useForm, useWatch, type Control, type FieldPath, type UseFormGetValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import {
  BackButton,
  FieldGroup,
  InlineError,
  OrbixButton,
  OrbixInput,
  OrbixModal,
  OrbixSelect,
  OrbixStepper,
  OrbixText,
  OrbixTextField,
  type SelectOption,
} from '@/components';
import { PlusIcon, TrashIcon } from '@/components/ui/icons';
import { OrbixGradient } from '@/components/ui/orbix-gradient';
import { useCreateCategory } from '@/features/products/use-product-mutations';
import { useAuth } from '@/hooks/use-auth';
import { usePermissions } from '@/hooks/use-permissions';
import { useTheme } from '@/hooks/use-theme';
import { ProductStatus, ProductType, TaxCode } from '@/types/api';
import { toUserMessage } from '@/utils/error-message';

import { buildProductSchema, type ProductFormValues } from './product-schemas';

export interface ProductFormProps {
  defaultValues: ProductFormValues;
  categoryOptions: SelectOption[];
  /** RECIPE is only meaningful for tenants with recipes enabled (restaurant). */
  allowRecipeType: boolean;
  skuEditable: boolean;
  submitLabel: string;
  submitting: boolean;
  serverError?: string | null;
  onSubmit: (values: ProductFormValues) => void;
  /** Editing an existing product → free step navigation, no gating. See file header. */
  isEditing?: boolean;
}

/**
 * Labelled, tappable step tabs — the free-navigation header used only in edit
 * mode. Each tab carries its section name instead of a bare number, so the
 * whole record's shape is readable at a glance and jumping to "Precios" no
 * longer means remembering that it is step 2.
 *
 * The label makes the separate step title underneath redundant, so it is not
 * rendered in edit mode.
 *
 * Drawn as a segmented control: one `muted` track holds the whole set, and the
 * selected step is a raised pill carrying the brand gradient — the same
 * `primary` gradient the buttons and `OrbixStepper` use, so edit mode reads as
 * the same wizard as create mode rather than a different control. Grouping them
 * on a shared track is what makes them read as one switch between sections
 * instead of five loose buttons.
 *
 * Padding (not `hitSlop`) is what makes the target: the 44dp floor clears the
 * touch guideline on its own, and unlike `hitSlop` the padded area is visible,
 * so adjacent tabs read as separate targets. They scroll horizontally because
 * five labels never fit across a phone.
 */
function StepTabs({
  steps,
  current,
  onSelect,
}: {
  steps: readonly { id: StepId; label: string }[]
  current: number
  onSelect: (index: number) => void
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // The track lives in the content container, not in a wrapper View: that
      // way it grows with the tabs and stays painted under them while scrolling,
      // instead of clipping to one screen width.
      contentContainerStyle={{
        flexDirection: 'row',
        gap: theme.spacing.xs,
        backgroundColor: theme.colors.muted,
        borderRadius: theme.radius.full,
        padding: theme.spacing.xs,
      }}
      accessibilityRole="tablist"
    >
      {steps.map((step, index) => {
        const active = index === current;
        return (
          <Pressable
            key={step.id}
            onPress={() => onSelect(index)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={step.label}
            style={({ pressed }) => ({
              borderRadius: theme.radius.full,
              // Clips the gradient to the pill; without it the corners square off.
              overflow: 'hidden',
              opacity: pressed ? 0.7 : 1,
              ...(active ? theme.shadows.sm : null),
            })}
          >
            {active ? <OrbixGradient variant="primary" style={[StyleSheet.absoluteFill, { borderRadius: theme.radius.full }]} /> : null}
            <View
              style={{
                minHeight: 44,
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.lg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <OrbixText
                size="md"
                weight={active ? 'semibold' : 'medium'}
                numberOfLines={1}
                style={{ 
                  color: active ? theme.colors.primaryForeground : theme.colors.mutedForeground ,
                  borderRadius: theme.radius.full,
                }}
              >
                {step.label}
              </OrbixText>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function SwitchRow({ label, hint, value, onValueChange }: { label: string; hint?: string; value: boolean; onValueChange: (v: boolean) => void }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
      <View style={{ flex: 1 }}>
        <OrbixText size="sm" weight="medium">{label}</OrbixText>
        {hint ? (
          <OrbixText size="xs" tone="mutedForeground" style={{ marginTop: 2 }}>{hint}</OrbixText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.muted, true: theme.colors.brandBlue300 }}
        thumbColor={value ? theme.colors.brandBlue600 : theme.colors.card}
      />
    </View>
  );
}

/**
 * Editor de las variantes con nombre del producto: "Talla M", "Extra queso".
 *
 * La variante **default** nunca aparece aquí. Es la línea interna "el producto
 * en sí" —la que lleva el stock de los productos que nunca se dividieron en
 * presentaciones— y el repositorio la filtra al mapear, igual que el web.
 *
 * Precio, costo y existencia son **de la sucursal activa**: viven en
 * `branch_inventory` por (sucursal, variante), así que no existe "el precio de
 * la variante" sino el de cada sucursal. Sin sucursal en la sesión el servidor
 * no tiene dónde escribirlos, y esos tres campos se deshabilitan en vez de
 * fingir que se guardan.
 *
 * Tarjetas apiladas, no una retícula como en el web: cuatro columnas de inputs
 * no caben a lo ancho de un teléfono sin volverse intocables.
 *
 * `keyName: 'key'` es obligatorio: por defecto `useFieldArray` llama `id` a su
 * clave de render y pisaría el `id` real de la variante — el único dato con el
 * que el servidor distingue una variante existente de una nueva.
 */
function VariantsEditor({
  control,
  getValues,
  branchScoped,
}: {
  control: Control<ProductFormValues>
  getValues: UseFormGetValues<ProductFormValues>
  branchScoped: boolean
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { fields, append, remove } = useFieldArray({ control, name: 'variants', keyName: 'key' });
  // Índice pendiente de confirmación: solo para las que ya existen en el
  // servidor, donde quitarlas se lleva su existencia en todas las sucursales.
  const [pendingRemoval, setPendingRemoval] = useState<number | null>(null);

  const requestRemove = (index: number, persisted: boolean) => {
    if (persisted) setPendingRemoval(index);
    else remove(index);
  };

  return (
    <View style={{ gap: theme.spacing.md }}>
      <OrbixText size="xs" tone="mutedForeground">
        {t(branchScoped ? 'products.variants.branchScopeHint' : 'products.variants.noBranchHint')}
      </OrbixText>

      {fields.length === 0 ? (
        <View
          style={{
            padding: theme.spacing.lg,
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: theme.colors.border,
          }}
        >
          <OrbixText size="xs" tone="mutedForeground" style={{ textAlign: 'center' }}>
            {t('products.variants.empty')}
          </OrbixText>
        </View>
      ) : null}

      {fields.map((field, index) => {
        // `field.id` es el de la variante en el servidor (ver `keyName`): solo
        // las nuevas lo traen vacío, y solo en ellas tiene sentido capturar una
        // existencia inicial — en las existentes el servidor la ignora, porque
        // el stock se mueve por movimientos de inventario.
        const persisted = Boolean(field.id);
        return (
          <View
            key={field.key}
            style={{
              gap: theme.spacing.sm + 2,
              padding: theme.spacing.md,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.card,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm + 2 }}>
              <View style={{ flex: 1 }}>
                <OrbixTextField
                  control={control}
                  name={`variants.${index}.name`}
                  label={t('products.variants.name')}
                  placeholder={t('products.variants.namePlaceholder')}
                  autoCapitalize="sentences"
                />
              </View>
              <Pressable
                onPress={() => requestRemove(index, persisted)}
                accessibilityRole="button"
                accessibilityLabel={t('products.variants.remove')}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: theme.radius.lg,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.colors.dangerBg,
                }}
              >
                <TrashIcon size={16} color={theme.colors.dangerFg} />
              </Pressable>
            </View>

            <View style={{ flexDirection: 'row', gap: theme.spacing.sm + 2 }}>
              <View style={{ flex: 1 }}>
                <OrbixTextField
                  control={control}
                  name={`variants.${index}.cost`}
                  label={t('products.variants.cost')}
                  keyboardType="decimal-pad"
                  editable={branchScoped}
                />
              </View>
              <View style={{ flex: 1 }}>
                <OrbixTextField
                  control={control}
                  name={`variants.${index}.price`}
                  label={t('products.variants.price')}
                  keyboardType="decimal-pad"
                  editable={branchScoped}
                />
              </View>
            </View>

            <View style={{ width: '50%' }}>
              <OrbixTextField
                control={control}
                name={`variants.${index}.stock`}
                label={t('products.variants.stock')}
                keyboardType="number-pad"
                editable={branchScoped && !persisted}
              />
            </View>
            {persisted ? (
              <OrbixText size="xs" tone="mutedForeground">
                {t('products.variants.stockReadonlyHint')}
              </OrbixText>
            ) : null}
          </View>
        );
      })}

      <OrbixButton
        label={t('products.variants.add')}
        variant="secondary"
        onPress={() => append({ name: '', cost: '', price: '', stock: '0' })}
      />

      <OrbixModal
        visible={pendingRemoval !== null}
        title={t('products.variants.removeConfirmTitle')}
        description={t('products.variants.removeConfirmDescription', {
          name: pendingRemoval === null ? '' : getValues(`variants.${pendingRemoval}.name`),
        })}
        confirmLabel={t('products.variants.remove')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => {
          if (pendingRemoval !== null) remove(pendingRemoval);
          setPendingRemoval(null);
        }}
        onDismiss={() => setPendingRemoval(null)}
      />
    </View>
  );
}

// One step per `products.section*` label already in the locale files —
// see the file-level comment for why the split lands here.
const STEP_IDS = ['general', 'pricing', 'category', 'inventory', 'variants', 'visibility'] as const;
type StepId = (typeof STEP_IDS)[number];

/** Fields validated before leaving a step — keeps `trigger()` scoped per step. */
const STEP_FIELDS: Record<StepId, FieldPath<ProductFormValues>[]> = {
  general: ['type', 'sku', 'name', 'description'],
  pricing: ['price', 'comparePrice', 'costPrice', 'taxRate', 'taxCode'],
  category: ['categoryId'],
  inventory: ['trackInventory', 'stock', 'lowStockAlert'],
  variants: ['variants'],
  visibility: ['status', 'isEcommerce'],
};

/** `products.section*` — same labels the fields used to sit under in one long scroll. */
const STEP_TITLE_KEYS: Record<StepId, 'products.sectionGeneral' | 'products.sectionPricing' | 'products.sectionCategory' | 'products.sectionInventory' | 'products.sectionVariants' | 'products.sectionVisibility'> = {
  general: 'products.sectionGeneral',
  pricing: 'products.sectionPricing',
  category: 'products.sectionCategory',
  inventory: 'products.sectionInventory',
  variants: 'products.sectionVariants',
  visibility: 'products.sectionVisibility',
};

export function ProductForm({
  defaultValues,
  categoryOptions,
  allowRecipeType,
  skuEditable,
  submitLabel,
  submitting,
  serverError,
  onSubmit,
  isEditing = false,
}: ProductFormProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { can } = usePermissions();
  const { session } = useAuth();
  // Precio, costo y existencia de una variante pertenecen a una sucursal. Sin
  // ninguna activa no hay dónde escribirlos — ver `VariantsEditor`.
  const branchScoped = Boolean(session?.branchId);

  const [newCategoryVisible, setNewCategoryVisible] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const createCategory = useCreateCategory();

  const schema = useMemo(() => buildProductSchema(t), [t]);
  const { control, handleSubmit, getValues, setValue, trigger } = useForm<ProductFormValues>({
    resolver: zodResolver(schema),
    defaultValues,
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });

  const type = useWatch({ control, name: 'type' });
  const trackInventory = useWatch({ control, name: 'trackInventory' });
  const isEcommerce = useWatch({ control, name: 'isEcommerce' });
  // `stock` es la existencia del producto "sin variante" (la default). En cuanto
  // hay variantes con nombre deja de tener sentido: lo inventariable son ellas,
  // y capturar aquí un número aparte creaba existencia que no pertenecía a
  // ninguna opción vendible. En edición tampoco se muestra: el servidor rechaza
  // el campo en el PATCH y la existencia se mueve por ajustes de inventario.
  const namedVariants = useWatch({ control, name: 'variants' });
  const showProductStock = !isEditing && (namedVariants?.length ?? 0) === 0;
  const isSimple = type === ProductType.SIMPLE;

  const [stepIndex, setStepIndex] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const stepId: StepId = STEP_IDS[stepIndex] ?? STEP_IDS[0];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === STEP_IDS.length - 1;

  const goNext = async () => {
    setAdvancing(true);
    const valid = await trigger(STEP_FIELDS[stepId]);
    setAdvancing(false);
    if (valid) setStepIndex((i) => Math.min(STEP_IDS.length - 1, i + 1));
  };
  const goBack = () => setStepIndex((i) => Math.max(0, i - 1));
  // Edit mode: no validation gate — the record already exists and is already
  // valid, jumping straight to step 4 to fix one field shouldn't require
  // re-passing steps 1-3 first. Whole-record validation still runs on submit.
  const jumpToStep = (index: number) => setStepIndex(index);

  const typeOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [
      { value: ProductType.SIMPLE, label: t('products.type.SIMPLE') },
      { value: ProductType.SERVICE, label: t('products.type.SERVICE') },
      { value: ProductType.COMBO, label: t('products.type.COMBO') },
    ];
    if (allowRecipeType) options.splice(1, 0, { value: ProductType.RECIPE, label: t('products.type.RECIPE') });
    return options;
  }, [allowRecipeType, t]);

  const statusOptions = useMemo<SelectOption[]>(
    () => Object.values(ProductStatus).map((value) => ({ value, label: t(`products.status.${value}`) })),
    [t],
  );

  /** Only read in edit mode, where the tabs replace the step title. */
  const stepTabs = useMemo(
    () => STEP_IDS.map((id) => ({ id, label: t(STEP_TITLE_KEYS[id]) })),
    [t],
  );

  const taxCodeOptions = useMemo<SelectOption[]>(
    () => Object.values(TaxCode).map((value) => ({ value, label: t(`products.taxCode.${value}`) })),
    [t],
  );

  const categorySelectOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: t('products.noCategory') }, ...categoryOptions],
    [categoryOptions, t],
  );

  const handleCreateCategory = () => {
    const name = newCategoryName.trim();
    if (!name) return;
    createCategory.mutate(
      { name },
      {
        onSuccess: (category) => {
          setValue('categoryId', category.id, { shouldValidate: false });
          setNewCategoryVisible(false);
          setNewCategoryName('');
        },
      },
    );
  };

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.lg }}>
        {isEditing ? (
          <StepTabs steps={stepTabs} current={stepIndex} onSelect={jumpToStep} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              {isFirstStep ? null : <BackButton onPress={goBack} accessibilityLabel={t('common.back')} size={32} />}
              <OrbixText size="sm" weight="semibold" tone="mutedForeground">
                {t('wizard.stepLabel', { current: String(stepIndex + 1), total: String(STEP_IDS.length) })}
                {'  ·  '}
                {t(STEP_TITLE_KEYS[stepId])}
              </OrbixText>
            </View>
            <OrbixStepper
              current={stepIndex + 1}
              total={STEP_IDS.length}
              accessibilityLabel={t('a11y.progress', {
                current: String(stepIndex + 1),
                total: String(STEP_IDS.length),
              })}
            />
          </>
        )}
      </View>

      <InlineError message={serverError} />

      {stepId === 'general' ? (
        <FieldGroup>
          <OrbixSelect control={control} name="type" label={t('products.fields.type')} options={typeOptions} />
          <OrbixTextField
            control={control}
            name="sku"
            label={t('products.fields.sku')}
            placeholder={t('products.fields.skuPlaceholder')}
            autoCapitalize="characters"
            editable={skuEditable}
          />
          <OrbixTextField
            control={control}
            name="name"
            label={t('products.fields.name')}
            placeholder={t('products.fields.namePlaceholder')}
            autoCapitalize="sentences"
          />
          <OrbixTextField
            control={control}
            name="description"
            label={t('products.fields.description')}
            placeholder={t('products.fields.descriptionPlaceholder')}
            multiline
            numberOfLines={3}
            height={80}
          />
        </FieldGroup>
      ) : null}

      {stepId === 'pricing' ? (
        <FieldGroup>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm + 2 }}>
            <View style={{ flex: 1 }}>
              <OrbixTextField control={control} name="price" label={t('products.fields.price')} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <OrbixTextField control={control} name="comparePrice" label={t('products.fields.comparePrice')} keyboardType="decimal-pad" />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm + 2 }}>
            <View style={{ flex: 1 }}>
              <OrbixTextField control={control} name="costPrice" label={t('products.fields.costPrice')} keyboardType="decimal-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <OrbixTextField control={control} name="taxRate" label={t('products.fields.taxRate')} keyboardType="decimal-pad" />
            </View>
          </View>
          <OrbixSelect control={control} name="taxCode" label={t('products.fields.taxCode')} options={taxCodeOptions} />
        </FieldGroup>
      ) : null}

      {stepId === 'category' ? (
        <FieldGroup>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm + 2 }}>
            <View style={{ flex: 1 }}>
              <OrbixSelect control={control} name="categoryId" label={t('products.fields.category')} options={categorySelectOptions} />
            </View>
            {can('categories:create') ? (
              <Pressable
                onPress={() => setNewCategoryVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={t('products.newCategory')}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.card,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <PlusIcon size={18} color={theme.colors.primary} />
              </Pressable>
            ) : null}
          </View>
        </FieldGroup>
      ) : null}

      {stepId === 'inventory' ? (
        <FieldGroup>
          {isSimple ? (
            <>
              <SwitchRow
                label={t('products.fields.trackInventory')}
                hint={t('products.fields.trackInventoryHint')}
                value={trackInventory}
                onValueChange={(v) => setValue('trackInventory', v, { shouldValidate: false })}
              />
              {trackInventory ? (
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm + 2 }}>
                  {showProductStock ? (
                    <View style={{ flex: 1 }}>
                      <OrbixTextField control={control} name="stock" label={t('products.fields.stock')} keyboardType="number-pad" />
                    </View>
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <OrbixTextField control={control} name="lowStockAlert" label={t('products.fields.lowStockAlert')} keyboardType="number-pad" />
                  </View>
                </View>
              ) : null}
            </>
          ) : (
            <View
              style={{
                padding: theme.spacing.md,
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.muted,
              }}
            >
              <OrbixText size="xs" tone="mutedForeground">
                {t(type === ProductType.SERVICE ? 'products.serviceInventoryHint' : 'products.nonSimpleInventoryHint')}
              </OrbixText>
            </View>
          )}
        </FieldGroup>
      ) : null}

      {stepId === 'variants' ? (
        <FieldGroup>
          {isSimple ? (
            <VariantsEditor control={control} getValues={getValues} branchScoped={branchScoped} />
          ) : (
            <View
              style={{
                padding: theme.spacing.md,
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.muted,
              }}
            >
              <OrbixText size="xs" tone="mutedForeground">
                {t('products.variants.nonSimpleHint')}
              </OrbixText>
            </View>
          )}
        </FieldGroup>
      ) : null}

      {stepId === 'visibility' ? (
        <FieldGroup>
          <OrbixSelect control={control} name="status" label={t('products.fields.status')} options={statusOptions} />
          <SwitchRow
            label={t('products.fields.isEcommerce')}
            hint={t('products.fields.isEcommerceHint')}
            value={isEcommerce}
            onValueChange={(v) => setValue('isEcommerce', v, { shouldValidate: false })}
          />
        </FieldGroup>
      ) : null}

      <OrbixModal
        visible={newCategoryVisible}
        title={t('products.newCategory')}
        confirmLabel={t('products.createCategory')}
        cancelLabel={t('common.cancel')}
        loading={createCategory.isPending}
        onConfirm={handleCreateCategory}
        onDismiss={() => {
          setNewCategoryVisible(false);
          setNewCategoryName('');
        }}
      >
        <View style={{ gap: theme.spacing.sm }}>
          <InlineError message={createCategory.error ? toUserMessage(createCategory.error, t) : null} />
          <OrbixInput
            value={newCategoryName}
            onChangeText={setNewCategoryName}
            placeholder={t('products.newCategoryPlaceholder')}
            autoFocus
            autoCapitalize="sentences"
          />
        </View>
      </OrbixModal>

      {isEditing || isLastStep ? (
        <OrbixButton label={submitLabel} onPress={handleSubmit(onSubmit)} loading={submitting} />
      ) : (
        <OrbixButton label={t('common.continue')} onPress={goNext} loading={advancing} />
      )}
    </View>
  );
}
