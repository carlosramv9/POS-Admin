import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { BackButton, OrbixLoading, OrbixModal, OrbixScaffold, OrbixText, toast } from '@/components';
import { TrashIcon } from '@/components/ui/icons';
import { ProductForm } from '@/features/products/product-form';
import { ProductImageField } from '@/features/products/product-image-field';
import { toUpdateRequest, type ProductFormValues } from '@/features/products/product-schemas';
import { useDeleteProduct, useUpdateProduct } from '@/features/products/use-product-mutations';
import { useCategories, useProduct } from '@/features/products/use-products';
import { useAuth } from '@/hooks/use-auth';
import { usePermissions } from '@/hooks/use-permissions';
import { useTheme } from '@/hooks/use-theme';
import { toUserMessage } from '@/utils/error-message';
import { ProductType } from '@/types/api';

function numToStr(value: number | null): string {
  return value === null ? '' : String(value);
}

export default function EditProductScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();
  const { can } = usePermissions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: product, isLoading } = useProduct(id);
  const { data: categories } = useCategories();
  const categoryOptions = useMemo(
    () => (categories ?? []).map((c) => ({ value: c.id, label: c.name })),
    [categories],
  );

  const update = useUpdateProduct(id);
  const remove = useDeleteProduct();

  const defaultValues = useMemo<ProductFormValues | null>(() => {
    if (!product) return null;
    return {
      type: product.type as ProductFormValues['type'],
      sku: product.sku,
      name: product.name,
      description: product.description,
      price: String(product.price),
      comparePrice: numToStr(product.comparePrice),
      costPrice: numToStr(product.costPrice),
      categoryId: product.categoryId ?? '',
      status: product.status as ProductFormValues['status'],
      stock: String(product.stock),
      trackInventory: product.trackInventory,
      lowStockAlert: String(product.lowStockAlert),
      taxRate: numToStr(product.taxRate),
      taxCode: (product.taxCode ?? 'IVA_16') as ProductFormValues['taxCode'],
      isEcommerce: product.isEcommerce,
      // Ya vienen sin la default (`toDomain` la filtra) y con el precio, el
      // costo y la existencia de la sucursal en contexto.
      //
      // El `?? []` no es paranoia: la caché de TanStack Query se rehidrata
      // desde MMKV, así que un producto guardado por una versión anterior de la
      // app llega sin `variants` por más que el tipo lo prometa.
      variants: (product.variants ?? []).map((variant) => ({
        id: variant.id,
        name: variant.name,
        cost: String(variant.cost),
        price: String(variant.price),
        stock: String(variant.stock),
      })),
    };
  }, [product]);

  const handleSubmit = (values: ProductFormValues) => {
    update.mutate(toUpdateRequest(values), {
      onSuccess: () => toast.success(t('products.updated')),
    });
  };

  const handleDelete = () => {
    remove.mutate(id, {
      onSuccess: () => {
        setConfirmDelete(false);
        router.back();
      },
      onError: (error) => {
        setConfirmDelete(false);
        toast.error(toUserMessage(error, t));
      },
    });
  };

  if (isLoading || !defaultValues) {
    return <OrbixLoading />;
  }

  return (
    <OrbixScaffold scrollable contentStyle={{ gap: theme.spacing.xl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
        <BackButton onPress={() => router.back()} accessibilityLabel={t('a11y.back')} />
        <OrbixText size="xl" weight="bold" numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
          {product?.name}
        </OrbixText>
        <Pressable
          onPress={() => setConfirmDelete(true)}
          accessibilityRole="button"
          accessibilityLabel={t('products.delete')}
          hitSlop={8}
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.dangerBg,
          }}
        >
          <TrashIcon size={16} color={theme.colors.dangerFg} />
        </Pressable>
      </View>

      <ProductImageField
        productId={id}
        image={product?.primaryImage ?? null}
        canEdit={can('products:edit')}
      />

      <ProductForm
        defaultValues={defaultValues}
        categoryOptions={categoryOptions}
        allowRecipeType={
          Boolean(session?.capabilities?.businessFeatures.enableRecipes) || defaultValues.type === ProductType.RECIPE
        }
        skuEditable={false}
        submitLabel={t('common.continue')}
        submitting={update.isPending}
        serverError={update.error ? toUserMessage(update.error, t) : null}
        onSubmit={handleSubmit}
        isEditing
      />

      <OrbixModal
        visible={confirmDelete}
        title={t('products.deleteConfirmTitle')}
        description={t('products.deleteConfirmDescription', { name: product?.name })}
        confirmLabel={t('products.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        loading={remove.isPending}
        onConfirm={handleDelete}
        onDismiss={() => setConfirmDelete(false)}
      />
    </OrbixScaffold>
  );
}
