import assert from 'assert';
import {
  ArrayType,
  ASTNode,
  BytesType,
  DataLocation,
  Expression,
  FunctionStateMutability,
  generalizeType,
  SourceUnit,
  StringType,
  StructDefinition,
  TypeNode,
  UserDefinedType,
} from 'solc-typed-ast';
import { AST } from '../../ast/ast';
import { printTypeNode } from '../../utils/astPrinter';
import { CairoType, TypeConversionContext } from '../../utils/cairoTypeSystem';
import { NotSupportedYetError } from '../../utils/errors';
import { createCairoFunctionStub, createCallToFunction } from '../../utils/functionGeneration';
import { getElementType, isDynamicArray, safeGetNodeType } from '../../utils/nodeTypeProcessing';
import { mapRange, narrowBigIntSafe, typeNameFromTypeNode } from '../../utils/utils';
import { uint256 } from '../../warplib/utils';
import { add, delegateBasedOnType, StringIndexedFuncGen } from '../base';
import { DynArrayGen } from './dynArray';

/*
  Generates functions to copy data from WARP_STORAGE to warp_memory
  Specifically this has to deal with structs, static arrays, and dynamic arrays
  These require extra care because the representations are different in storage and memory
  In storage nested structures are stored in place, whereas in memory 'pointers' are used
*/

export class StorageToMemoryGen extends StringIndexedFuncGen {
  constructor(private dynArrayGen: DynArrayGen, ast: AST, sourceUnit: SourceUnit) {
    super(ast, sourceUnit);
  }
  gen(node: Expression, nodeInSourceUnit?: ASTNode): Expression {
    const type = generalizeType(safeGetNodeType(node, this.ast.inference))[0];

    const name = this.getOrCreate(type);
    const functionStub = createCairoFunctionStub(
      name,
      [['loc', typeNameFromTypeNode(type, this.ast), DataLocation.Storage]],
      [['mem_loc', typeNameFromTypeNode(type, this.ast), DataLocation.Memory]],
      ['syscall_ptr', 'pedersen_ptr', 'range_check_ptr', 'warp_memory'],
      this.ast,
      nodeInSourceUnit ?? node,
      { mutability: FunctionStateMutability.View },
    );
    return createCallToFunction(functionStub, [node], this.ast);
  }

  private getOrCreate(type: TypeNode): string {
    const key = type.pp();
    const existing = this.generatedFunctions.get(key);
    if (existing !== undefined) {
      return existing.name;
    }

    const unexpectedTypeFunc = () => {
      throw new NotSupportedYetError(
        `Copying ${printTypeNode(type)} from storage to memory not implemented yet`,
      );
    };

    return delegateBasedOnType<string>(
      type,
      (type) => this.createDynamicArrayCopyFunction(key, type),
      (type) => this.createStaticArrayCopyFunction(key, type),
      (type) => this.createStructCopyFunction(key, type),
      unexpectedTypeFunc,
      unexpectedTypeFunc,
    );
  }

  private createStructCopyFunction(key: string, type: UserDefinedType): string {
    const memoryType = CairoType.fromSol(type, this.ast, TypeConversionContext.MemoryAllocation);

    const funcName = `ws_to_memory${this.generatedFunctions.size}`;
    const implicits =
      '{syscall_ptr : felt*, pedersen_ptr : HashBuiltin*, range_check_ptr : felt, warp_memory : DictAccess*}';

    // Set an empty entry so recursive function generation doesn't clash
    this.generatedFunctions.set(key, { name: funcName, code: '' });

    this.generatedFunctions.set(key, {
      name: funcName,
      code: [
        `func ${funcName}${implicits}(loc : felt) -> (mem_loc: felt){`,
        `    alloc_locals;`,
        `    let (mem_start) = wm_alloc(${uint256(memoryType.width)});`,
        ...generateCopyInstructions(type, this.ast).flatMap(
          ({ storageOffset, copyType }, index) => [
            this.getIterCopyCode(copyType, index, storageOffset),
            `dict_write{dict_ptr=warp_memory}(${add('mem_start', index)}, copy${index});`,
          ],
        ),
        `    return (mem_start,);`,
        `}`,
      ].join('\n'),
    });

    this.requireImport('starkware.cairo.common.dict', 'dict_write');
    this.requireImport('warplib.memory', 'wm_alloc');

    return funcName;
  }

  private createStaticArrayCopyFunction(key: string, type: ArrayType): string {
    assert(type.size !== undefined, 'Expected static array with known size');
    return type.size <= 5
      ? this.createSmallStaticArrayCopyFunction(key, type)
      : this.createLargeStaticArrayCopyFunction(key, type);
  }

  private createSmallStaticArrayCopyFunction(key: string, type: ArrayType) {
    const memoryType = CairoType.fromSol(type, this.ast, TypeConversionContext.MemoryAllocation);

    const funcName = `ws_to_memory${this.generatedFunctions.size}`;
    const implicits =
      '{syscall_ptr : felt*, pedersen_ptr : HashBuiltin*, range_check_ptr : felt, warp_memory : DictAccess*}';

    // Set an empty entry so recursive function generation doesn't clash
    this.generatedFunctions.set(key, { name: funcName, code: '' });

    this.generatedFunctions.set(key, {
      name: funcName,
      code: [
        `func ${funcName}${implicits}(loc : felt) -> (mem_loc : felt){`,
        `    alloc_locals;`,
        `    let length = ${uint256(memoryType.width)};`,
        `    let (mem_start) = wm_alloc(length);`,
        ...generateCopyInstructions(type, this.ast).flatMap(
          ({ storageOffset, copyType }, index) => [
            this.getIterCopyCode(copyType, index, storageOffset),
            `dict_write{dict_ptr=warp_memory}(${add('mem_start', index)}, copy${index});`,
          ],
        ),
        `    return (mem_start,);`,
        `}`,
      ].join('\n'),
    });

    this.requireImport('starkware.cairo.common.dict', 'dict_write');
    this.requireImport('warplib.memory', 'wm_alloc');

    return funcName;
  }

  private createLargeStaticArrayCopyFunction(key: string, type: ArrayType) {
    assert(type.size !== undefined, 'Expected static array with known size');
    const funcName = `ws_to_memory${this.generatedFunctions.size}`;
    const length = narrowBigIntSafe(
      type.size,
      `Failed to narrow size of ${printTypeNode(type)} in memory->storage copy generation`,
    );
    const implicits =
      '{syscall_ptr : felt*, pedersen_ptr : HashBuiltin*, range_check_ptr : felt, warp_memory : DictAccess*}';

    // Set an empty entry so recursive function generation doesn't clash
    this.generatedFunctions.set(key, { name: funcName, code: '' });

    const elementMemoryWidth = CairoType.fromSol(type.elementT, this.ast).width;
    const elementStorageWidth = CairoType.fromSol(
      type.elementT,
      this.ast,
      TypeConversionContext.StorageAllocation,
    ).width;

    const copyCode: string = this.getRecursiveCopyCode(
      type.elementT,
      elementMemoryWidth,
      'loc',
      'mem_start',
    );

    this.generatedFunctions.set(key, {
      name: funcName,
      code: [
        `func ${funcName}_elem${implicits}(mem_start: felt, loc : felt, length: Uint256) -> (){`,
        `   alloc_locals;`,
        `   if (length.low == 0){`,
        `       if (length.high == 0){`,
        `           return ();`,
        `       }`,
        `   }`,
        `   let (index) = uint256_sub(length, Uint256(1, 0));`,
        copyCode,
        `   return ${funcName}_elem(${add('mem_start', elementMemoryWidth)}, ${add(
          'loc',
          elementStorageWidth,
        )}, index);`,
        `}`,

        `func ${funcName}${implicits}(loc : felt) -> (mem_loc : felt){`,
        `    alloc_locals;`,
        `    let length = ${uint256(length)};`,
        `    let (mem_start) = wm_alloc(length);`,
        `    ${funcName}_elem(mem_start, loc, length);`,
        `    return (mem_start,);`,
        `}`,
      ].join('\n'),
    });

    this.requireImport('starkware.cairo.common.dict', 'dict_write');
    this.requireImport('warplib.memory', 'wm_alloc');
    this.requireImport('starkware.cairo.common.uint256', 'uint256_sub');
    this.requireImport('starkware.cairo.common.uint256', 'Uint256');

    return funcName;
  }

  private createDynamicArrayCopyFunction(
    key: string,
    type: ArrayType | BytesType | StringType,
  ): string {
    const elementT = getElementType(type);
    const memoryElementType = CairoType.fromSol(elementT, this.ast);
    const funcName = `ws_to_memory${this.generatedFunctions.size}`;
    this.generatedFunctions.set(key, {
      name: funcName,
      code: '',
    });

    const [elemMapping, lengthMapping] = this.dynArrayGen.gen(
      CairoType.fromSol(elementT, this.ast, TypeConversionContext.StorageAllocation),
    );
    const implicits =
      '{syscall_ptr : felt*, pedersen_ptr : HashBuiltin*, range_check_ptr : felt, warp_memory : DictAccess*}';

    // This is the code to copy a single element
    // Complex types require calls to another function generated here
    // Simple types take one or two WARP_STORAGE-dict_write pairs
    const copyCode: string = this.getRecursiveCopyCode(
      elementT,
      memoryElementType.width,
      'element_storage_loc',
      'mem_loc',
    );

    // Now generate two functions: the setup function funcName, and the elementwise copy function: funcName_elem
    this.generatedFunctions.set(key, {
      name: funcName,
      code: [
        `func ${funcName}_elem${implicits}(storage_name: felt, mem_start: felt, length: Uint256) -> (){`,
        `    alloc_locals;`,
        `    if (length.low == 0 and length.high == 0){`,
        `        return ();`,
        `    }`,
        `    let (index) = uint256_sub(length, Uint256(1,0));`,
        `    let (mem_loc) = wm_index_dyn(mem_start, index, ${uint256(memoryElementType.width)});`,
        `    let (element_storage_loc) = ${elemMapping}.read(storage_name, index);`,
        copyCode,
        `    return ${funcName}_elem(storage_name, mem_start, index);`,
        `}`,

        `func ${funcName}${implicits}(loc : felt) -> (mem_loc : felt){`,
        `    alloc_locals;`,
        `    let (length: Uint256) = ${lengthMapping}.read(loc);`,
        `    let (mem_start) = wm_new(length, ${uint256(memoryElementType.width)});`,
        `    ${funcName}_elem(loc, mem_start, length);`,
        `    return (mem_start,);`,
        `}`,
      ].join('\n'),
    });

    this.requireImport('starkware.cairo.common.dict', 'dict_write');
    this.requireImport('starkware.cairo.common.uint256', 'uint256_sub');
    this.requireImport('starkware.cairo.common.uint256', 'Uint256');
    this.requireImport('warplib.memory', 'wm_new');
    this.requireImport('warplib.memory', 'wm_index_dyn');

    return funcName;
  }

  // Copy code generation for iterative copy instructions (small static arrays and structs)
  private getIterCopyCode(
    copyType: TypeNode | undefined,
    index: number,
    storageOffset: number,
  ): string {
    if (copyType === undefined) {
      return `let (copy${index}) = WARP_STORAGE.read(${add('loc', storageOffset)});`;
    }

    const funcName = this.getOrCreate(copyType);
    return isDynamicArray(copyType)
      ? [
          `let (dyn_loc) = WARP_STORAGE.read(${add('loc', storageOffset)});`,
          `let (copy${index}) = ${funcName}(dyn_loc);`,
        ].join('\n')
      : `let (copy${index}) = ${funcName}(${add('loc', storageOffset)});`;
  }

  // Copy code generation for recursive copy instructions (large static arrays and dynamic arrays)
  private getRecursiveCopyCode(
    elementT: TypeNode,
    elementMemoryWidth: number,
    storageLoc: string,
    memoryLoc: string,
  ) {
    if (isStaticArrayOrStruct(elementT)) {
      return [
        `   let (copy) = ${this.getOrCreate(elementT)}(${storageLoc});`,
        `   dict_write{dict_ptr=warp_memory}(${memoryLoc}, copy);`,
      ].join('\n');
    } else if (isDynamicArray(elementT)) {
      return [
        `   let (dyn_loc) = readId(${storageLoc});`,
        `   let (copy) = ${this.getOrCreate(elementT)}(dyn_loc);`,
        `   dict_write{dict_ptr=warp_memory}(${memoryLoc}, copy);`,
      ].join('\n');
    } else {
      return mapRange(elementMemoryWidth, (n) =>
        [
          `   let (copy) = WARP_STORAGE.read(${add(`${storageLoc}`, n)});`,
          `   dict_write{dict_ptr=warp_memory}(${add(`${memoryLoc}`, n)}, copy);`,
        ].join('\n'),
      ).join('\n');
    }
  }
}

type CopyInstruction = {
  // The offset into the storage object to copy
  storageOffset: number;
  // If the copy requires a recursive call, this is the type to copy
  copyType?: TypeNode;
};

function generateCopyInstructions(type: TypeNode, ast: AST): CopyInstruction[] {
  let members: TypeNode[];

  if (type instanceof UserDefinedType && type.definition instanceof StructDefinition) {
    members = type.definition.vMembers.map((decl) => safeGetNodeType(decl, ast.inference));
  } else if (type instanceof ArrayType && type.size !== undefined) {
    const narrowedWidth = narrowBigIntSafe(type.size, `Array size ${type.size} not supported`);
    members = mapRange(narrowedWidth, () => type.elementT);
  } else {
    throw new NotSupportedYetError(
      `Copying ${printTypeNode(type)} from storage to memory not implemented yet`,
    );
  }

  let storageOffset = 0;
  return members.flatMap((memberType) => {
    if (isStaticArrayOrStruct(memberType)) {
      const offset = storageOffset;
      storageOffset += CairoType.fromSol(
        memberType,
        ast,
        TypeConversionContext.StorageAllocation,
      ).width;
      return [{ storageOffset: offset, copyType: memberType }];
    } else if (isDynamicArray(memberType)) {
      return [{ storageOffset: storageOffset++, copyType: memberType }];
    } else {
      const width = CairoType.fromSol(
        memberType,
        ast,
        TypeConversionContext.StorageAllocation,
      ).width;
      return mapRange(width, () => ({ storageOffset: storageOffset++ }));
    }
  });
}

function isStaticArrayOrStruct(type: TypeNode) {
  return (
    (type instanceof ArrayType && type.size !== undefined) ||
    (type instanceof UserDefinedType && type.definition instanceof StructDefinition)
  );
}
