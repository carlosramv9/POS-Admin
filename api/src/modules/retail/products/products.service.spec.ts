import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { AuditService } from '../../../common/services/audit.service';
import { R2Service } from '../../../storage/r2.service';
import { BusinessConfigurationService } from '../../../common/business-config/business-configuration.service';
import { InventoryEngine } from '../inventory/inventory.engine';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';
import { SlugUtil } from '../../../common/utils/slug.util';
import { AiUsageRecorder } from '../../../ai/usage/ai-usage.recorder';

describe('ProductsService', () => {
  let service: ProductsService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    product: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      fields: {
        lowStockAlert: 5,
      },
    },
    category: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    productImage: {
      create: jest.fn(),
      delete: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    inventoryMovement: { create: jest.fn() },
    // El alta siembra la variante default del producto y su fila de existencias
    // en cada sucursal activa; sin sucursales el sembrado es un no-op.
    productVariant: {
      create: jest.fn().mockResolvedValue({ id: 'variant-default' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    branch: { findMany: jest.fn().mockResolvedValue([]) },
    branchInventory: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (tx: unknown) => unknown) =>
      cb({
        product: {
          update: mockPrismaService.product.update,
          create: mockPrismaService.product.create,
          // El servicio usa ambos dentro de la transacción.
          findFirst: mockPrismaService.product.findFirst,
          findUnique: mockPrismaService.product.findFirst,
          // `update` regenera el slug y consulta los existentes.
          findMany: mockPrismaService.product.findMany,
          findFirstOrThrow: mockPrismaService.product.findFirst,
        },
        inventoryMovement: { create: jest.fn() },
        productVariant: mockPrismaService.productVariant,
        branch: mockPrismaService.branch,
        branchInventory: mockPrismaService.branchInventory,
      }),
    ),
  };

  const mockTenantContext = {
    requireTenantId: jest.fn().mockReturnValue('tenant-1'),
    getBranchId: jest.fn().mockReturnValue(null),
  };
  const mockAuditService = { log: jest.fn() };
  const mockR2Service = { upload: jest.fn(), delete: jest.fn(), buildKey: jest.fn().mockReturnValue('key') };
  const mockBusinessConfig = { hasFeature: jest.fn().mockResolvedValue(false) };
  const mockInventoryEngine = {
    applyProductStockDelta: jest.fn().mockResolvedValue({ applied: true, variantId: 'v-p1', branchId: 'b1' }),
    recordProductMovement: jest.fn().mockResolvedValue(undefined),
  };
  const mockAiUsageRecorder = { recordOutcome: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TenantContextService, useValue: mockTenantContext },
        { provide: AuditService, useValue: mockAuditService },
        { provide: R2Service, useValue: mockR2Service },
        { provide: BusinessConfigurationService, useValue: mockBusinessConfig },
        { provide: InventoryEngine, useValue: mockInventoryEngine },
        {
          provide: VariantInventoryResolver,
          useValue: { resolveBranchId: jest.fn().mockResolvedValue(null) },
        },
        { provide: AiUsageRecorder, useValue: mockAiUsageRecorder },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    prismaService = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new product', async () => {
      const createProductDto = {
        sku: 'TEST-001',
        name: 'Test Product',
        description: 'Test description',
        price: 99.99,
        categoryId: 'cat-1',
        status: 'ACTIVE' as const,
      };

      const mockProduct = {
        id: '1',
        ...createProductDto,
        slug: 'test-product',
        comparePrice: null,
        costPrice: null,
        stock: 0,
        trackInventory: true,
        lowStockAlert: 5,
        metaTitle: null,
        metaDescription: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        category: { id: 'cat-1', name: 'Category' },
        images: [],
      };

      mockPrismaService.product.findUnique.mockResolvedValue(null);
      // El alta ahora siempre re-consulta el producto al final, para devolverlo
      // ya con la variante default que acaba de sembrar.
      mockPrismaService.product.findFirst.mockResolvedValue(mockProduct);
      mockPrismaService.category.findFirst.mockResolvedValue({ id: 'cat-1' });
      mockPrismaService.product.findMany.mockResolvedValue([]);
      mockPrismaService.product.create.mockResolvedValue(mockProduct);
      jest.spyOn(SlugUtil, 'generateUnique').mockReturnValue('test-product');

      const result = await service.create(createProductDto);

      expect(result.sku).toBe(createProductDto.sku);
      expect(result.slug).toBe('test-product');
      expect(mockPrismaService.product.create).toHaveBeenCalled();
    });

    it('should throw ConflictException if SKU exists', async () => {
      const createProductDto = {
        sku: 'EXISTING-SKU',
        name: 'Test Product',
        price: 99.99,
      };

      mockPrismaService.product.findUnique.mockResolvedValue({ id: '1' });

      await expect(service.create(createProductDto as any)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw NotFoundException if category not found', async () => {
      const createProductDto = {
        sku: 'TEST-001',
        name: 'Test Product',
        price: 99.99,
        categoryId: 'invalid-cat',
      };

      mockPrismaService.product.findUnique.mockResolvedValue(null);
      mockPrismaService.product.findFirst.mockResolvedValue(null);
      mockPrismaService.category.findFirst.mockResolvedValue(null);

      await expect(service.create(createProductDto as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('should return paginated products', async () => {
      const queryDto = { page: 1, limit: 10, skip: 0 };
      const mockProducts = [
        {
          id: '1',
          sku: 'TEST-001',
          name: 'Test Product',
          price: 99.99,
          category: null,
          images: [],
          _count: { orderItems: 0 },
        },
      ];

      mockPrismaService.product.findMany.mockResolvedValue(mockProducts);
      mockPrismaService.product.count.mockResolvedValue(1);

      const result = await service.findAll(queryDto);

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
    });

    it('should filter products by search term', async () => {
      const queryDto = { page: 1, limit: 10, skip: 0, search: 'test' };

      mockPrismaService.product.findMany.mockResolvedValue([]);
      mockPrismaService.product.count.mockResolvedValue(0);

      await service.findAll(queryDto);

      expect(mockPrismaService.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.any(Array),
          }),
        }),
      );
    });
  });

  describe('findOne', () => {
    it('should return a product by id', async () => {
      const productId = '1';
      const mockProduct = {
        id: productId,
        sku: 'TEST-001',
        name: 'Test Product',
        category: null,
        images: [],
        _count: { orderItems: 0 },
      };

      mockPrismaService.product.findFirst.mockResolvedValue(mockProduct);

      const result = await service.findOne(productId);

      expect(result.id).toBe(productId);
    });

    it('should throw NotFoundException if product not found', async () => {
      mockPrismaService.product.findFirst.mockResolvedValue(null);

      await expect(service.findOne('invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('should update a product', async () => {
      const productId = '1';
      const updateDto = { name: 'Updated Product' };
      const mockProduct = {
        id: productId,
        sku: 'TEST-001',
        name: 'Test Product',
        slug: 'test-product',
      };

      const updatedProduct = { ...mockProduct, name: 'Updated Product' };

      // Comprueba existencia y luego relee el registro ya escrito.
      mockPrismaService.product.findFirst
        .mockResolvedValueOnce(mockProduct)
        .mockResolvedValue(updatedProduct);
      mockPrismaService.product.update.mockResolvedValue(updatedProduct);

      const result = await service.update(productId, updateDto);

      expect(result.name).toBe('Updated Product');
    });

    it('should throw NotFoundException if product not found', async () => {
      mockPrismaService.product.findFirst.mockResolvedValue(null);

      await expect(service.update('invalid-id', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('uploadImage', () => {
    it('should throw NotFoundException when product not found', async () => {
      mockPrismaService.product.findFirst.mockResolvedValue(null);

      await expect(
        service.uploadImage('non-existent', { buffer: Buffer.from('') } as Express.Multer.File),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStock', () => {
    it('should update product stock', async () => {
      const productId = '1';
      const quantity = 10;
      const mockProduct = {
        id: productId,
        stock: 5,
        trackInventory: true,
        type: 'SIMPLE',
      };

      const updatedProduct = { ...mockProduct, stock: 15 };

      // Comprueba existencia y luego relee el registro ya escrito.
      mockPrismaService.product.findFirst
        .mockResolvedValueOnce(mockProduct)
        .mockResolvedValue(updatedProduct);
      mockPrismaService.product.update.mockResolvedValue(updatedProduct);

      const result = await service.updateStock(productId, quantity);

      expect(result.stock).toBe(15);
    });

    it('should throw error for insufficient stock', async () => {
      const productId = '1';
      const mockProduct = {
        id: productId,
        stock: 5,
        trackInventory: true,
      };

      mockPrismaService.product.findFirst.mockResolvedValue(mockProduct);

      await expect(service.updateStock(productId, -10)).rejects.toThrow();
    });
  });
});
