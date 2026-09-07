import { Injectable, BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { PrismaService } from '../../../database/prisma.service';
import { TenantContextService } from '../../../common/context/tenant-context.service';
import { SlugUtil } from '../../../common/utils/slug.util';
import { VariantInventoryResolver } from '../inventory/variant-inventory.resolver';
import { Product, ProductStatus, TaxCode } from '@prisma/client';

const SHEET_PRODUCTS = 'Productos';
const SHEET_CATEGORIES = 'Categorías';

const HEADERS = [
  'SKU',
  'Nombre',
  'Descripción',
  'Categoría',
  'Precio',
  'Precio Comparación',
  'Costo',
  'Estado',
  'Stock',
  'Rastrear Inventario',
  'Stock Mínimo',
  'Código Impuesto',
  'Publicar en E-commerce',
] as const;

const TEMPLATE_ROWS = 500;
const STATUS_VALUES: ProductStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
const TAX_CODE_VALUES: TaxCode[] = ['IVA_16', 'IVA_11', 'IVA_8', 'EXCENTO'];

export interface ImportRowError {
  row: number;
  sku?: string;
  message: string;
}

export interface ImportResult {
  totalRows: number;
  created: number;
  updated: number;
  errors: ImportRowError[];
}

@Injectable()
export class ProductsImportService {
  constructor(
    private prisma: PrismaService,
    private tenantContext: TenantContextService,
    private variants: VariantInventoryResolver,
  ) {}

  /** Builds a ready-to-fill .xlsx: headers + dropdowns + the tenant's real category names. */
  async buildTemplate(): Promise<Buffer> {
    const tenantId = this.tenantContext.requireTenantId();
    const categories = await this.prisma.category.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { name: true },
      orderBy: { name: 'asc' },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Orbix';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(SHEET_PRODUCTS);
    sheet.columns = HEADERS.map((header) => ({ header, key: header, width: 22 }));
    sheet.getRow(1).font = { bold: true };

    sheet.addRow({
      SKU: 'DEMO-001',
      Nombre: 'Producto de ejemplo',
      Descripción: 'Descripción opcional',
      Categoría: categories[0]?.name ?? '',
      Precio: 100,
      Estado: 'ACTIVE',
      Stock: 10,
      'Rastrear Inventario': 'SI',
      'Stock Mínimo': 5,
      'Código Impuesto': 'IVA_16',
      'Publicar en E-commerce': 'NO',
    });

    const catRange =
      categories.length > 0 ? `'${SHEET_CATEGORIES}'!$A$2:$A$${categories.length + 1}` : null;

    for (let row = 2; row <= TEMPLATE_ROWS; row++) {
      sheet.getCell(`H${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${STATUS_VALUES.join(',')}"`],
      };
      sheet.getCell(`J${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"SI,NO"'],
      };
      sheet.getCell(`L${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${TAX_CODE_VALUES.join(',')}"`],
      };
      sheet.getCell(`M${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"SI,NO"'],
      };
      if (catRange) {
        sheet.getCell(`D${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [catRange],
        };
      }
    }

    const catSheet = workbook.addWorksheet(SHEET_CATEGORIES);
    catSheet.getColumn(1).width = 32;
    catSheet.addRow(['Categorías disponibles']);
    catSheet.getRow(1).font = { bold: true };
    categories.forEach((c) => catSheet.addRow([c.name]));

    const instructions = workbook.addWorksheet('Instrucciones');
    instructions.getColumn(1).width = 92;
    [
      'Cómo llenar esta plantilla',
      '',
      '• SKU, Nombre y Precio son obligatorios.',
      '• Si el SKU ya existe en tu catálogo, el producto se actualiza; si no existe, se crea.',
      '• Categoría debe coincidir exactamente con un nombre de la hoja "Categorías" (o dejarse vacío).',
      '• Estado: DRAFT, ACTIVE o ARCHIVED — vacío se toma como ACTIVE.',
      '• Rastrear Inventario / Publicar en E-commerce: SI o NO.',
      '• Código Impuesto: IVA_16, IVA_11, IVA_8 o EXCENTO — vacío se toma como IVA_16.',
      '• Esta importación solo crea/actualiza productos tipo Simple. Recetas, combos,',
      '  atributos y características se agregan después desde el panel de Inventario.',
    ].forEach((line) => instructions.addRow([line]));

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /** Parses an uploaded .xlsx and upserts products by (tenant, SKU) — best-effort per row. */
  async importFile(buffer: Buffer): Promise<ImportResult> {
    const tenantId = this.tenantContext.requireTenantId();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet(SHEET_PRODUCTS) ?? workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException('El archivo no tiene hojas para leer');
    }

    const columnIndex = new Map<string, number>();
    (sheet.getRow(1).values as unknown[]).forEach((value, idx) => {
      if (typeof value === 'string') columnIndex.set(value.trim(), idx);
    });

    for (const col of ['SKU', 'Nombre', 'Precio']) {
      if (!columnIndex.has(col)) {
        throw new BadRequestException(`Falta la columna requerida "${col}" en el archivo`);
      }
    }

    const [categories, existingProducts] = await Promise.all([
      this.prisma.category.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      this.prisma.product.findMany({ where: { tenantId }, select: { sku: true, slug: true } }),
    ]);
    const categoryByName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const existingSkus = new Set(existingProducts.map((p) => p.sku));
    const usedSlugs = existingProducts.map((p) => p.slug);

    const cellText = (row: ExcelJS.Row, col: string): string => {
      const idx = columnIndex.get(col);
      if (!idx) return '';
      const val = row.getCell(idx).value as unknown;
      if (val === null || val === undefined) return '';
      if (typeof val === 'object') {
        const obj = val as { text?: unknown; result?: unknown };
        if ('text' in obj) return String(obj.text ?? '').trim();
        if ('result' in obj) return String(obj.result ?? '').trim();
      }
      return String(val).trim();
    };

    const cellBoolean = (row: ExcelJS.Row, col: string, defaultValue: boolean): boolean => {
      const raw = cellText(row, col).toUpperCase();
      if (!raw) return defaultValue;
      return ['SI', 'SÍ', 'YES', 'TRUE', '1'].includes(raw);
    };

    const result: ImportResult = { totalRows: 0, created: 0, updated: 0, errors: [] };

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      if (row.actualCellCount === 0) continue;

      const sku = cellText(row, 'SKU');
      const name = cellText(row, 'Nombre');
      const priceRaw = cellText(row, 'Precio');
      if (!sku && !name && !priceRaw) continue;

      result.totalRows++;

      if (!sku) {
        result.errors.push({ row: rowNumber, message: 'Falta el SKU' });
        continue;
      }
      if (!name) {
        result.errors.push({ row: rowNumber, sku, message: 'Falta el nombre' });
        continue;
      }
      const price = Number(priceRaw);
      if (!priceRaw || Number.isNaN(price) || price < 0) {
        result.errors.push({ row: rowNumber, sku, message: 'Precio inválido' });
        continue;
      }

      const categoryName = cellText(row, 'Categoría');
      let categoryId: string | null = null;
      if (categoryName) {
        const match = categoryByName.get(categoryName.trim().toLowerCase());
        if (!match) {
          result.errors.push({ row: rowNumber, sku, message: `Categoría "${categoryName}" no existe` });
          continue;
        }
        categoryId = match;
      }

      const statusRaw = cellText(row, 'Estado').toUpperCase();
      if (statusRaw && !STATUS_VALUES.includes(statusRaw as ProductStatus)) {
        result.errors.push({ row: rowNumber, sku, message: `Estado "${statusRaw}" inválido` });
        continue;
      }

      const taxCodeRaw = cellText(row, 'Código Impuesto').toUpperCase();
      if (taxCodeRaw && !TAX_CODE_VALUES.includes(taxCodeRaw as TaxCode)) {
        result.errors.push({ row: rowNumber, sku, message: `Código Impuesto "${taxCodeRaw}" inválido` });
        continue;
      }

      const comparePriceRaw = cellText(row, 'Precio Comparación');
      const costRaw = cellText(row, 'Costo');
      const stockRaw = cellText(row, 'Stock');
      const lowStockRaw = cellText(row, 'Stock Mínimo');

      const data = {
        name,
        description: cellText(row, 'Descripción') || null,
        categoryId,
        price,
        comparePrice: comparePriceRaw ? Number(comparePriceRaw) : null,
        costPrice: costRaw ? Number(costRaw) : null,
        status: (statusRaw || 'ACTIVE') as ProductStatus,
        stock: stockRaw ? Math.max(0, Math.trunc(Number(stockRaw))) : 0,
        trackInventory: cellBoolean(row, 'Rastrear Inventario', true),
        lowStockAlert: lowStockRaw ? Math.max(0, Math.trunc(Number(lowStockRaw))) : 5,
        taxCode: (taxCodeRaw || 'IVA_16') as TaxCode,
        isEcommerce: cellBoolean(row, 'Publicar en E-commerce', false),
      };

      try {
        if (existingSkus.has(sku)) {
          const updated = await this.prisma.product.update({
            where: { tenantId_sku: { tenantId, sku } },
            data,
          });
          await this.syncBranchInventory(tenantId, updated, data.stock);
          result.updated++;
        } else {
          const slug = SlugUtil.generateUnique(name, usedSlugs);
          usedSlugs.push(slug);
          existingSkus.add(sku);
          const created = await this.prisma.product.create({
            data: { ...data, tenantId, sku, slug, type: 'SIMPLE' },
          });
          await this.syncBranchInventory(tenantId, created, data.stock);
          result.created++;
        }
      } catch (err) {
        result.errors.push({
          row: rowNumber,
          sku,
          message: err instanceof Error ? err.message : 'Error desconocido al guardar',
        });
      }
    }

    return result;
  }

  /**
   * Refleja en el inventario por variante lo que trae la hoja de cálculo.
   *
   * La hoja tiene UNA columna de stock, así que ese número se aplica solo a la
   * sucursal de destino (la del contexto, o la principal) — replicarlo en todas
   * multiplicaría la existencia. Los valores comerciales (precio, costo, mínimo)
   * sí se propagan a todas las sucursales, porque son del catálogo.
   */
  private async syncBranchInventory(
    tenantId: string,
    product: Product,
    /**
     * Existencia que trae la hoja para esta fila. Se pasa explícita en vez de
     * releerla de `products.stock`: esa columna es el espejo legacy —la suma de
     * todas las variantes de todas las sucursales— y se retira con la fase
     * contract. Aquí lo que manda es el número que capturó el usuario.
     */
    stockDeLaHoja: number,
  ): Promise<void> {
    const variantId = await this.variants.ensureDefaultVariantId(this.prisma, product.id, tenantId);
    if (!variantId) return;

    const branches = await this.prisma.branch.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: { id: true, isMain: true },
    });
    if (branches.length === 0) return;

    const contextBranchId = this.tenantContext.getBranchId();
    const targetBranchId =
      (contextBranchId && branches.some((b) => b.id === contextBranchId) ? contextBranchId : null) ??
      branches.find((b) => b.isMain)?.id ??
      branches[0].id;

    const commercial = {
      price: product.price,
      cost: product.costPrice,
      comparePrice: product.comparePrice,
      lowStockAlert: product.lowStockAlert,
    };

    for (const branch of branches) {
      const isTarget = branch.id === targetBranchId;
      await this.prisma.branchInventory.upsert({
        where: { branchId_variantId: { branchId: branch.id, variantId } },
        update: isTarget ? { ...commercial, stock: stockDeLaHoja } : commercial,
        create: {
          branchId: branch.id,
          productId: product.id,
          variantId,
          stock: isTarget ? stockDeLaHoja : 0,
          ...commercial,
        },
      });
    }
  }
}
