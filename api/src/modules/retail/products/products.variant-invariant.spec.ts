import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';

/**
 * Invariantes del modelo de variantes (ADR-0030).
 *
 *  1. Todo producto tiene SIEMPRE al menos una variante. Sin ella no es
 *     direccionable en el inventario y deja de ser vendible; borrarla además
 *     arrastraría en cascada sus filas de `branch_inventory`. No es expresable
 *     como CHECK en la base, así que se fija aquí y en el servicio (la última
 *     presentación que se quita se degrada a default, nunca se borra).
 *  2. La default no tiene nombre, y una variante con nombre no es default. Eso
 *     sí vive en la base (`product_variants_default_has_no_name`).
 *  3. Con varias presentaciones, nadie elige por el llamador.
 */
describe('Invariantes de la variante por omisión', () => {
  const resolver = new VariantInventoryResolver();

  const txCon = (variants: { id: string; isDefault: boolean; name: string | null }[]) => ({
    productVariant: {
      findMany: jest.fn().mockResolvedValue(variants.slice(0, 2)),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'v-nueva' }),
    },
    product: {
      findFirst: jest.fn().mockResolvedValue({ price: 100, costPrice: 60, trackInventory: true }),
    },
  });

  it('un producto sin presentaciones resuelve su default', async () => {
    const tx = txCon([{ id: 'v-default', isDefault: true, name: null }]);
    await expect(resolver.resolveVariantId(tx as never, 'p1', 't1')).resolves.toBe('v-default');
  });

  it('un producto con UNA presentación resuelve esa, aunque ya no sea default', async () => {
    // Es el estado que deja la promoción: la default se renombró a "Talla M" y
    // dejó de ser default. Filtrar por `isDefault` aquí devolvía null y el motor
    // caía al camino legacy sobre `Product.stock`, dejando de mover el
    // inventario por variante.
    const tx = txCon([{ id: 'v-talla-m', isDefault: false, name: 'Talla M' }]);
    await expect(resolver.resolveVariantId(tx as never, 'p1', 't1')).resolves.toBe('v-talla-m');
  });

  it('con varias presentaciones exige que el llamador diga cuál', async () => {
    const tx = txCon([
      { id: 'v-talla-m', isDefault: false, name: 'Talla M' },
      { id: 'v-talla-l', isDefault: false, name: 'Talla L' },
    ]);

    // Falla en vez de elegir: descontar en silencio de una presentación
    // cualquiera no se nota hasta que cuadran el inventario.
    await expect(resolver.resolveVariantId(tx as never, 'p1', 't1')).rejects.toThrow(
      'indica cuál con `variantId`',
    );
  });

  it('sin ninguna variante devuelve null y el llamador cae al legacy', async () => {
    const tx = txCon([]);
    await expect(resolver.resolveVariantId(tx as never, 'p1', 't1')).resolves.toBeNull();
  });

  it('ensureDefaultVariantId no crea una default junto a las presentaciones', async () => {
    // Crearla reintroduciría la línea fantasma que la promoción eliminó: una
    // variante sin nombre cargando stock contra la que descuenta todo por
    // omisión.
    const tx = txCon([
      { id: 'v-talla-m', isDefault: false, name: 'Talla M' },
      { id: 'v-talla-l', isDefault: false, name: 'Talla L' },
    ]);

    await expect(resolver.ensureDefaultVariantId(tx as never, 'p1', 't1')).rejects.toThrow(
      'indica cuál con `variantId`',
    );
    expect(tx.productVariant.create).not.toHaveBeenCalled();
  });

  it('ensureDefaultVariantId sí siembra la default cuando no hay ninguna variante', async () => {
    const tx = txCon([]);

    await expect(resolver.ensureDefaultVariantId(tx as never, 'p1', 't1')).resolves.toBe('v-nueva');
    expect(tx.productVariant.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: null, isDefault: true }) }),
    );
  });
});
