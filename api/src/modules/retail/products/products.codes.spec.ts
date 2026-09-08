import { ConflictException } from '@nestjs/common';

import { ProductsService } from './products.service';

/**
 * `sku` y `barcode` de una presentación son únicos POR EMPRESA.
 *
 * La restricción no cabe en un índice de `product_variants`: esa tabla no tiene
 * `tenantId` —su dueño es el producto— y Postgres no admite un índice único que
 * cruce tablas. Vive en el servicio, así que estos casos son la única red que
 * la sostiene.
 */
describe('ProductsService — códigos únicos por empresa', () => {
  const TENANT = 't1';

  /** `ocupados` son las variantes que ya existen en la empresa. */
  function build(ocupados: { id: string; sku: string | null; barcode: string | null }[]) {
    const buscarChoque = jest.fn(
      ({ where }: { where: { id?: { notIn: string[] }; OR: { sku?: { in: string[] }; barcode?: { in: string[] } }[] } }) => {
        const excluidos = where.id?.notIn ?? [];
        const skus = where.OR.flatMap((o) => o.sku?.in ?? []);
        const barcodes = where.OR.flatMap((o) => o.barcode?.in ?? []);
        const hit = ocupados.find(
          (v) =>
            !excluidos.includes(v.id) &&
            ((v.sku !== null && skus.includes(v.sku)) || (v.barcode !== null && barcodes.includes(v.barcode))),
        );
        return Promise.resolve(hit ? [{ ...hit, product: { name: 'Producto ocupado' } }] : []);
      },
    );

    const service = new ProductsService(
      {} as never,
      { requireTenantId: () => TENANT, getBranchId: () => null } as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { recordOutcome: jest.fn() } as never,
    );

    const tx = { productVariant: { findMany: buscarChoque } };

    // El método es privado a propósito: se ejercita por su nombre porque es la
    // regla, no un detalle — probarlo a través de `create` obligaría a montar
    // toda la transacción para observar una sola validación.
    const assert = (
      codes: { sku?: string | null; barcode?: string | null }[],
      except: string[] = [],
    ) =>
      (service as unknown as {
        assertCodesFreeInTenant: (
          tx: unknown,
          tenantId: string,
          codes: { sku?: string | null; barcode?: string | null }[],
          except?: string[],
        ) => Promise<void>;
      }).assertCodesFreeInTenant(tx, TENANT, codes, except);

    return { assert, buscarChoque };
  }

  it('deja pasar códigos libres', async () => {
    const { assert } = build([{ id: 'v1', sku: 'A-1', barcode: '111' }]);
    await expect(assert([{ sku: 'A-2', barcode: '222' }])).resolves.toBeUndefined();
  });

  it('rechaza un barcode que ya usa otro producto de la empresa', async () => {
    const { assert } = build([{ id: 'v1', sku: null, barcode: '111' }]);
    await expect(assert([{ barcode: '111' }])).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza un sku que ya usa otro producto de la empresa', async () => {
    const { assert } = build([{ id: 'v1', sku: 'A-1', barcode: null }]);
    await expect(assert([{ sku: 'A-1' }])).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza el duplicado DENTRO del mismo envío', async () => {
    // Dos presentaciones nuevas con el mismo código: ninguna existe todavía, así
    // que la base no las vería chocar.
    const { assert } = build([]);
    await expect(assert([{ barcode: '111' }, { barcode: '111' }])).rejects.toThrow(
      'está repetido entre las presentaciones',
    );
  });

  it('no choca consigo mismo al reguardar sin cambiar el código', async () => {
    const { assert } = build([{ id: 'v1', sku: 'A-1', barcode: '111' }]);
    await expect(assert([{ sku: 'A-1', barcode: '111' }], ['v1'])).resolves.toBeUndefined();
  });

  it('los códigos vacíos no cuentan como duplicados', async () => {
    // Varias presentaciones sin código son legítimas: "sin código" no es un
    // valor que colisione.
    const { assert, buscarChoque } = build([{ id: 'v1', sku: null, barcode: null }]);
    await expect(
      assert([{ sku: '', barcode: '   ' }, { sku: undefined, barcode: null }]),
    ).resolves.toBeUndefined();
    expect(buscarChoque).not.toHaveBeenCalled();
  });
});
