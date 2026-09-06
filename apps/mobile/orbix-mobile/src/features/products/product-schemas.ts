/**
 * Product create/edit form schema.
 *
 * Money/quantity fields stay strings in the form (React Native text inputs are
 * string-valued) and are parsed to numbers only at submit time, in
 * `toCreateRequest`/`toUpdateRequest` — mirrors the phone-field pattern in
 * `wizard-schemas.ts`.
 */
import type { TFunction } from 'i18next';
import { z } from 'zod';

import type { CreateProductRequest, ProductVariantInput, UpdateProductRequest } from '@/dto/products.dto';
import { ProductStatus, ProductType, TaxCode } from '@/types/api';

const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const INTEGER_RE = /^\d+$/;

export function buildProductSchema(t: TFunction) {
  const money = (required: boolean) => {
    const base = z.string().trim();
    return required
      ? base.min(1, t('validation.priceRequired')).regex(MONEY_RE, t('validation.priceInvalid'))
      : base.regex(MONEY_RE, t('validation.priceInvalid')).optional().or(z.literal(''));
  };
  const integer = () => z.string().trim().regex(INTEGER_RE, t('validation.integerInvalid')).optional().or(z.literal(''));

  return z.object({
    type: z.enum([ProductType.SIMPLE, ProductType.RECIPE, ProductType.COMBO, ProductType.SERVICE]),
    sku: z.string().trim().min(2, t('validation.skuTooShort')).max(100),
    name: z.string().trim().min(2, t('validation.nameTooShort')).max(200),
    description: z.string().trim().max(2000).optional().or(z.literal('')),
    price: money(true),
    comparePrice: money(false),
    costPrice: money(false),
    categoryId: z.string().optional(),
    status: z.enum([ProductStatus.DRAFT, ProductStatus.ACTIVE, ProductStatus.INACTIVE, ProductStatus.ARCHIVED]),
    stock: integer(),
    trackInventory: z.boolean(),
    lowStockAlert: integer(),
    taxRate: money(false),
    taxCode: z.enum([TaxCode.IVA_16, TaxCode.IVA_11, TaxCode.IVA_8, TaxCode.EXCENTO]),
    isEcommerce: z.boolean(),
    /**
     * Solo las variantes con nombre — la default es interna y nunca llega al
     * formulario (`toDomain` la filtra).
     *
     * `id` es lo que distingue una variante existente de una nueva: sin él el
     * servidor no puede sincronizar y guardar el producto se llevaría por
     * delante las existencias de todas las sucursales.
     */
    variants: z.array(
      z.object({
        id: z.string().optional(),
        name: z.string().trim().min(1, t('validation.variantNameRequired')).max(200),
        cost: money(false),
        price: money(false),
        stock: integer(),
      }),
    ),
  });
}

export type ProductFormValues = z.infer<ReturnType<typeof buildProductSchema>>;

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  type: ProductType.SIMPLE,
  sku: '',
  name: '',
  description: '',
  price: '',
  comparePrice: '',
  costPrice: '',
  categoryId: '',
  status: ProductStatus.DRAFT,
  stock: '0',
  trackInventory: true,
  lowStockAlert: '5',
  taxRate: '',
  taxCode: TaxCode.IVA_16,
  isEcommerce: false,
  variants: [],
};

function num(value: string | undefined): number | undefined {
  if (!value || value.trim() === '') return undefined;
  return Number(value);
}

/**
 * Variantes que viajan al servidor.
 *
 * Solo para SIMPLE: es el único tipo cuyo formulario muestra el editor, y
 * mandar un arreglo vacío desde un COMBO borraría las variantes que el producto
 * ya tuviera —con sus existencias en cascada— sin que nadie lo haya pedido.
 * `undefined` deja intacto lo que haya en el servidor.
 *
 * El filtro por nombre es defensa: el schema ya lo exige, pero una fila recién
 * agregada y nunca llenada no tiene por qué llegar a la API.
 */
function toVariantsRequest(values: ProductFormValues): ProductVariantInput[] | undefined {
  if (values.type !== ProductType.SIMPLE) return undefined;
  return values.variants
    .filter((variant) => variant.name.trim() !== '')
    .map((variant) => ({
      id: variant.id,
      name: variant.name.trim(),
      cost: num(variant.cost) ?? 0,
      price: num(variant.price) ?? 0,
      stock: num(variant.stock) ?? 0,
    }));
}

/** Every field but `sku`, shared by create and update. */
function toBaseRequest(values: ProductFormValues): Omit<CreateProductRequest, 'sku'> {
  return {
    type: values.type,
    name: values.name.trim(),
    description: values.description?.trim() || undefined,
    price: num(values.price) ?? 0,
    comparePrice: num(values.comparePrice),
    costPrice: num(values.costPrice),
    categoryId: values.categoryId || undefined,
    status: values.status,
    stock: num(values.stock) ?? 0,
    trackInventory: values.trackInventory,
    lowStockAlert: num(values.lowStockAlert) ?? 0,
    taxRate: num(values.taxRate),
    taxCode: values.taxCode,
    isEcommerce: values.isEcommerce,
    variants: toVariantsRequest(values),
  };
}

export function toCreateRequest(values: ProductFormValues): CreateProductRequest {
  return { ...toBaseRequest(values), sku: values.sku.trim() };
}

/**
 * sku is immutable after creation — the API has no field to receive it on PATCH.
 *
 * Neither does `stock`: the API rejects it. Writing it only moved the legacy
 * mirror column on the product without touching the per-branch inventory that
 * is actually read back, so the number appeared to change and nothing happened.
 * Stock moves through `PATCH /products/:id/stock`, which records a movement.
 */
export function toUpdateRequest(values: ProductFormValues): UpdateProductRequest {
  const { stock: _stock, ...rest } = toBaseRequest(values);
  return rest;
}
