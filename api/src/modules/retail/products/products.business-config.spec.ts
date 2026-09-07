import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditService } from '../../../common/services/audit.service';
import { R2Service } from '../../../storage/r2.service';
import { BusinessConfigurationService } from '../../../common/business-config/business-configuration.service';
import { InventoryEngine } from '../inventory/inventory.engine';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';
import { AiUsageRecorder } from '../../../ai/usage/ai-usage.recorder';

// BR-02: recipes are gated behind the `enableRecipes` feature. SIMPLE/SERVICE/
// COMBO products stay available on every vertical; combos never touch recipes.
describe('ProductsService — BR-02 recipe gating', () => {
  let service: ProductsService;

  const createdProduct = { id: 'prod-1', sku: 'SKU1', name: 'Widget', type: 'SIMPLE' };

  /**
   * Lo que `create` devuelve ahora: la misma forma que `findOne`, con `stock`
   * calculado desde las filas de (sucursal, variante). Antes devolvia el
   * producto crudo, asi que el mismo registro traia un `stock` distinto segun
   * se acabara de crear o se releyera.
   */
  const createdResponse = { ...createdProduct, variants: [], stock: 0 };

  const mockPrisma = {
    product: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    category: { findFirst: jest.fn() },
    $transaction: jest.fn().mockResolvedValue(createdProduct),
  };
  const mockTenantContext = {
    requireTenantId: jest.fn().mockReturnValue('tenant-1'),
    // El alta consulta la sucursal en contexto para sembrar precio/costo de las
    // variantes: sin sucursal, todas nacen con los valores del producto.
    getBranchId: jest.fn().mockReturnValue(undefined),
  };
  const mockAudit = { log: jest.fn() };
  const mockR2 = { upload: jest.fn(), delete: jest.fn(), buildKey: jest.fn() };
  const mockBusinessConfig = { hasFeature: jest.fn() };
  const mockInventoryEngine = {
    applyProductStockDelta: jest.fn().mockResolvedValue({ applied: true, variantId: 'v-p1', branchId: 'b1' }),
    recordProductMovement: jest.fn().mockResolvedValue(undefined),
    getProductStock: jest.fn().mockResolvedValue(null),
  };
  const mockAiUsageRecorder = { recordOutcome: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.product.findUnique.mockResolvedValue(null);
    mockPrisma.product.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockResolvedValue(createdProduct);

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

  const dto = (over: Record<string, unknown> = {}) =>
    ({ sku: 'SKU1', name: 'Widget', price: 10, ...over }) as never;

  it('injects BusinessConfigurationService', () => {
    expect(service).toBeDefined();
  });

  // ── Retail (recipes disabled) ─────────────────────────────────────────────
  it('Retail: SIMPLE product creates without consulting recipes (no gate)', async () => {
    mockBusinessConfig.hasFeature.mockResolvedValue(false);
    await expect(service.create(dto())).resolves.toEqual(createdResponse);
    expect(mockBusinessConfig.hasFeature).not.toHaveBeenCalled();
  });

  it('Retail: COMBO stays available and never touches recipes (combos independent)', async () => {
    mockBusinessConfig.hasFeature.mockResolvedValue(false);
    await expect(service.create(dto({ type: 'COMBO' }))).resolves.toEqual(createdResponse);
    expect(mockBusinessConfig.hasFeature).not.toHaveBeenCalled();
  });

  it('Retail: RECIPE product is blocked (ForbiddenException)', async () => {
    mockBusinessConfig.hasFeature.mockResolvedValue(false);
    await expect(service.create(dto({ type: 'RECIPE' }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockBusinessConfig.hasFeature).toHaveBeenCalledWith('enableRecipes');
  });

  it('Retail: getRecipe and upsertRecipe are blocked', async () => {
    mockBusinessConfig.hasFeature.mockResolvedValue(false);
    await expect(service.getRecipe('p1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.upsertRecipe('p1', [])).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ── Restaurant (recipes enabled) ──────────────────────────────────────────
  it('Restaurant: RECIPE product is allowed', async () => {
    mockBusinessConfig.hasFeature.mockResolvedValue(true);
    await expect(service.create(dto({ type: 'RECIPE' }))).resolves.toEqual(createdResponse);
    expect(mockBusinessConfig.hasFeature).toHaveBeenCalledWith('enableRecipes');
  });
});
