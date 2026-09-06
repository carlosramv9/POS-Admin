import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditService } from '../../../common/services/audit.service';
import { R2Service } from '../../../storage/r2.service';
import { BusinessConfigurationService } from '../../../common/business-config/business-configuration.service';
import { InventoryEngine } from '../inventory/inventory.engine';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';
import { AiUsageRecorder } from '../../../ai/usage/ai-usage.recorder';
import { CreateProductDto } from './dto/create-product.dto';

/**
 * Aislamiento de tenant en las referencias que un producto compuesto guarda a
 * OTROS registros: `childProductId` (combos) y `supplyId` (recetas).
 *
 * El producto padre siempre se resuelve con `findFirst({ id, tenantId })`, así
 * que un tenant no puede editar un producto ajeno. Estos tests cubren el otro
 * lado: los ids que viajan en el body y se insertan tal cual, sin comprobar a
 * qué tenant pertenecen.
 *
 * Un `childProductId` ajeno persistido se vuelve explotable al vender, porque
 * `InventoryConsumptionEngine` expande el combo y descuenta stock resolviendo
 * cada hoja por id, también sin filtro de tenant (ver
 * `inventory-consumption.tenant-isolation.spec.ts`).
 */
describe('ProductsService — aislamiento de tenant en referencias', () => {
  const TENANT = 'tenant-1';
  const FOREIGN_PRODUCT_ID = 'producto-de-otro-tenant';
  const FOREIGN_SUPPLY_ID = 'insumo-de-otro-tenant';

  let service: ProductsService;

  // Registro de lo que se persistió, para poder afirmar sobre el efecto y no
  // solo sobre la excepción.
  let comboItemsCreated: Array<{ childProductId: string }>;
  let recipeItemsCreated: Array<{ supplyId: string }>;

  const mockPrisma = {
    product: {
      // SKU libre y, para los upsert, el padre existe y es del tenant actual.
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    category: { findFirst: jest.fn() },
    comboItem: { createMany: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
    recipe: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    recipeItem: { deleteMany: jest.fn() },
    supply: { findFirst: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  const mockTenantContext = {
    requireTenantId: jest.fn().mockReturnValue(TENANT),
    getBranchId: jest.fn().mockReturnValue(undefined),
  };
  const mockAudit = { log: jest.fn() };
  const mockR2 = { upload: jest.fn(), delete: jest.fn(), buildKey: jest.fn() };
  const mockBusinessConfig = { hasFeature: jest.fn().mockResolvedValue(true) };
  const mockInventoryEngine = {
    applyProductStockDelta: jest.fn(),
    recordProductMovement: jest.fn(),
  };
  const mockAiUsageRecorder = { recordOutcome: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    comboItemsCreated = [];
    recipeItemsCreated = [];

    const createdProduct = { id: 'nuevo-producto', tenantId: TENANT, type: 'COMBO' };

    mockPrisma.product.findUnique.mockResolvedValue(null); // SKU libre / refetch
    mockPrisma.product.findMany.mockResolvedValue([]); // slugs existentes
    mockPrisma.product.create.mockResolvedValue(createdProduct);
    mockPrisma.comboItem.createMany.mockImplementation(({ data }: { data: any[] }) => {
      comboItemsCreated.push(...data);
      return Promise.resolve({ count: data.length });
    });
    mockPrisma.comboItem.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.comboItem.findMany.mockResolvedValue([]);
    mockPrisma.recipe.findUnique.mockResolvedValue(null);
    mockPrisma.recipe.create.mockImplementation(({ data }: { data: any }) => {
      recipeItemsCreated.push(...(data.items?.create ?? []));
      return Promise.resolve({ id: 'receta-1' });
    });

    // El tx expone los mismos mocks, de forma que las aserciones valen tanto
    // dentro como fuera de la transacción.
    // El tx expone los mismos mocks de product/combo/recipe, de forma que las
    // aserciones valen tanto dentro como fuera de la transacción. El resto son
    // colaboradores que `create` toca ANTES de llegar al bloque de combo
    // (variante default + siembra de inventario): sin ellos la creación
    // reventaba antes de tiempo y los tests pasaban por el motivo equivocado.
    mockPrisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb({
        product: mockPrisma.product,
        comboItem: mockPrisma.comboItem,
        recipe: mockPrisma.recipe,
        recipeItem: mockPrisma.recipeItem,
        productAttribute: { createMany: jest.fn(), deleteMany: jest.fn() },
        productFeature: { createMany: jest.fn(), deleteMany: jest.fn() },
        supply: mockPrisma.supply,
        productVariant: {
          create: jest.fn().mockResolvedValue({ id: 'variante-default' }),
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn(),
          deleteMany: jest.fn(),
        },
        // Sin sucursales activas, `seedBranchInventory` sale temprano.
        branch: { findMany: jest.fn().mockResolvedValue([]) },
        branchInventory: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantContextService, useValue: mockTenantContext },
        { provide: AuditService, useValue: mockAudit },
        { provide: R2Service, useValue: mockR2 },
        { provide: BusinessConfigurationService, useValue: mockBusinessConfig },
        { provide: InventoryEngine, useValue: mockInventoryEngine },
        {
          provide: VariantInventoryResolver,
          useValue: { resolveBranchId: jest.fn().mockResolvedValue(null) },
        },
        { provide: AiUsageRecorder, useValue: mockAiUsageRecorder },
      ],
    }).compile();

    service = module.get(ProductsService);
  });

  const comboDto = (childProductId: string): CreateProductDto =>
    ({
      sku: 'COMBO-1',
      name: 'Combo con hijo ajeno',
      price: 100,
      type: 'COMBO',
      comboItems: [{ childProductId, quantity: 1 }],
    }) as unknown as CreateProductDto;

  describe('el producto padre sí está protegido', () => {
    it('upsertComboItems sobre un producto de otro tenant → 404', async () => {
      // findFirst({ id, tenantId, type: 'COMBO' }) no encuentra nada.
      mockPrisma.product.findFirst.mockResolvedValue(null);

      await expect(
        service.upsertComboItems('combo-ajeno', [
          { childProductId: 'x', quantity: 1 },
        ]),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.product.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT }),
        }),
      );
    });
  });

  describe('los hijos referenciados NO están protegidos', () => {
    it('create(COMBO) rechaza un childProductId de otro tenant', async () => {
      await expect(service.create(comboDto(FOREIGN_PRODUCT_ID))).rejects.toThrow();

      // Aunque no lance, el id ajeno no debe haberse persistido nunca.
      expect(comboItemsCreated).not.toContainEqual(
        expect.objectContaining({ childProductId: FOREIGN_PRODUCT_ID }),
      );
    });

    it('create(COMBO) comprueba la propiedad del hijo antes de insertarlo', async () => {
      await service.create(comboDto(FOREIGN_PRODUCT_ID)).catch(() => undefined);

      // La comprobación esperada: buscar el hijo acotado al tenant actual. Se
      // acepta tanto la consulta por id como la de lote (`id: { in: [...] }`),
      // que es la que usa el servicio para validar todos los hijos de una vez —
      // lo que importa es que el id ajeno se busque bajo el tenant del contexto,
      // no la forma de la consulta.
      const mentionsChildUnderTenant = ([args]: [any]) => {
        const where = args?.where;
        if (where?.tenantId !== TENANT) return false;
        const id = where?.id;
        return id === FOREIGN_PRODUCT_ID || (Array.isArray(id?.in) && id.in.includes(FOREIGN_PRODUCT_ID));
      };

      const scopedLookup =
        mockPrisma.product.findFirst.mock.calls.some(mentionsChildUnderTenant) ||
        mockPrisma.product.findMany.mock.calls.some(mentionsChildUnderTenant);

      expect(scopedLookup).toBe(true);
    });

    it('upsertComboItems rechaza un childProductId de otro tenant', async () => {
      // El padre sí es del tenant actual.
      mockPrisma.product.findFirst.mockResolvedValue({
        id: 'combo-1',
        tenantId: TENANT,
        type: 'COMBO',
      });

      await expect(
        service.upsertComboItems('combo-1', [
          { childProductId: FOREIGN_PRODUCT_ID, quantity: 1 },
        ]),
      ).rejects.toThrow();

      expect(comboItemsCreated).not.toContainEqual(
        expect.objectContaining({ childProductId: FOREIGN_PRODUCT_ID }),
      );
    });

    it('upsertRecipe rechaza un supplyId de otro tenant', async () => {
      mockPrisma.product.findFirst.mockResolvedValue({
        id: 'receta-1',
        tenantId: TENANT,
        type: 'RECIPE',
      });

      await expect(
        service.upsertRecipe('receta-1', [
          { supplyId: FOREIGN_SUPPLY_ID, quantity: 1, unit: 'kg' },
        ]),
      ).rejects.toThrow();

      expect(recipeItemsCreated).not.toContainEqual(
        expect.objectContaining({ supplyId: FOREIGN_SUPPLY_ID }),
      );
    });
  });
});
