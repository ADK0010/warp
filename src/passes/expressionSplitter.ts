import assert from 'assert';
import {
  Assignment,
  ContractDefinition,
  DataLocation,
  ExpressionStatement,
  FunctionCall,
  FunctionDefinition,
  Identifier,
  Mutability,
  StateVariableVisibility,
  VariableDeclaration,
  VariableDeclarationStatement,
  generalizeType,
} from 'solc-typed-ast';
import { AST } from '../ast/ast';
import { ASTMapper } from '../ast/mapper';
import { printNode } from '../utils/astPrinter';
import { cloneASTNode } from '../utils/cloning';
import { TranspileFailedError } from '../utils/errors';
import { SPLIT_EXPRESSION_PREFIX } from '../utils/nameModifiers';
import {
  createEmptyTuple,
  createExpressionStatement,
  createIdentifier,
  createVariableDeclarationStatement,
} from '../utils/nodeTemplates';
import { safeGetNodeType } from '../utils/nodeTypeProcessing';
import { counterGenerator } from '../utils/utils';

function* expressionGenerator(prefix: string): Generator<string, string, unknown> {
  const count = counterGenerator();
  while (true) {
    yield `${prefix}${count.next().value}`;
  }
}

export class ExpressionSplitter extends ASTMapper {
  eGen = expressionGenerator(SPLIT_EXPRESSION_PREFIX);

  // Function to add passes that should have been run before this pass
  addInitialPassPrerequisites(): void {
    const passKeys: Set<string> = new Set<string>([
      // Conditionals must have been handled before this pass, otherwise
      // both branches of the conditional might get evaluated when they are
      // extracted by the splitter.
      'Cos',
    ]);
    passKeys.forEach((key) => this.addPassPrerequisite(key));
  }

  visitAssignment(node: Assignment, ast: AST): void {
    this.commonVisit(node, ast);

    // No need to split if it is a statement
    if (node.parent instanceof ExpressionStatement) {
      return;
    }

    // No need to create temp vars for state vars since they
    // are functionalized during the reference pass
    if (
      node.vLeftHandSide instanceof Identifier &&
      identifierReferenceStateVar(node.vLeftHandSide)
    ) {
      return;
    }

    this.splitSimpleAssignment(node, ast);
  }

  visitFunctionCall(node: FunctionCall, ast: AST): void {
    this.commonVisit(node, ast);
    if (
      !(node.vReferencedDeclaration instanceof FunctionDefinition) ||
      node.parent instanceof ExpressionStatement ||
      node.parent instanceof VariableDeclarationStatement
    ) {
      return;
    }

    const returnTypes = node.vReferencedDeclaration.vReturnParameters.vParameters;
    if (returnTypes.length === 0) {
      const parent = node.parent;
      assert(parent !== undefined, `${printNode(node)} ${node.vFunctionName} has no parent`);
      ast.replaceNode(node, createEmptyTuple(ast));
      ast.insertStatementBefore(parent, createExpressionStatement(ast, node));
    } else if (returnTypes.length === 1) {
      assert(
        returnTypes[0].vType !== undefined,
        'Return types should not be undefined since solidity 0.5.0',
      );
      ast.extractToConstant(node, cloneASTNode(returnTypes[0].vType, ast), this.eGen.next().value);
    } else {
      throw new TranspileFailedError(
        `ExpressionSplitter expects functions to have at most 1 return argument. ${printNode(
          node,
        )} ${node.vFunctionName} has ${returnTypes.length}`,
      );
    }
  }

  splitSimpleAssignment(node: Assignment, ast: AST): void {
    const initialValue = node.vRightHandSide;
    const location =
      generalizeType(safeGetNodeType(initialValue, ast.inference))[1] ?? DataLocation.Default;
    const varDecl = new VariableDeclaration(
      ast.reserveId(),
      '', // src
      false, // constant
      false, // indexed
      this.eGen.next().value,
      ast.getContainingScope(node),
      false, // stateVariable
      location,
      StateVariableVisibility.Internal,
      Mutability.Constant,
      node.vLeftHandSide.typeString,
    );

    const tempVarStatement = createVariableDeclarationStatement([varDecl], initialValue, ast);
    const tempVar = tempVarStatement.vDeclarations[0];

    const leftHandSide = cloneASTNode(node.vLeftHandSide, ast);
    const rightHandSide = createIdentifier(tempVar, ast, undefined, node);
    const assignment = new Assignment(
      ast.reserveId(),
      '', // src
      leftHandSide.typeString,
      '=', // operator
      leftHandSide,
      rightHandSide,
    );
    const updateVal = createExpressionStatement(ast, assignment);

    // b = (a=7) + 4
    // ~>
    // __warp_se = 7
    // a = __warp_se
    // b = (__warp_se) + 4
    ast.insertStatementBefore(node, tempVarStatement);
    ast.insertStatementBefore(node, updateVal);
    ast.replaceNode(node, createIdentifier(tempVar, ast));
  }
}

function identifierReferenceStateVar(id: Identifier) {
  const refDecl = id.vReferencedDeclaration;
  return (
    refDecl instanceof VariableDeclaration &&
    refDecl.getClosestParentByType(ContractDefinition)?.id === refDecl.scope
  );
}
