var TypeScript = require('./ts')
var fs = require('fs')
var program = require('commander')
var Map = require('./map')
require('sugar')
var util = require('util')

program
    .parse(process.argv)

var file = program.args[0]
var text = fs.readFileSync(file, 'utf8')
var ast = TypeScript.parse(text)

function getLine(node) {
    return ast.lineMap.getLineNumberFromPosition(node.minChar)
}


// --------------------
// Scope Chains
// --------------------

function TTopLevelScope(obj) {
	this.obj = obj;
}
TTopLevelScope.prototype.lookupType = function(x) {
	console.log("Lookup up " + x + " in top-level")
	return this.obj.types.get(x)
}
TTopLevelScope.prototype.lookupTypeParam = function(x) {
	return null;
}

// TModuleScope contains all symbols exported from the merged module with the given qualified name
function TModuleScope(localName, parent) {
    this.localName = localName;
    this.parent = parent;
    this.obj = null;
}
TModuleScope.prototype.lookupType = function(x) {
	if (!this.obj) {
		this.obj = this.parent.lookupType(this.localName)
		if (!this.obj)
			throw new Error("Module " + this.localName + " was never defined")
	}
	return this.obj.types.get(x) || this.parent && this.parent.lookupType(x)
}
TModuleScope.prototype.lookupTypeParam = function(x) {
	return this.parent && this.parent.lookupTypeParam(x);
}

// TTypeParameterScope contains type parameters. These must be resolved early (see merging phase)
function TTypeParameterScope(parent) {
    this.env = new Map
    this.parent = parent;
}
TTypeParameterScope.prototype.lookupType = function(x) {
	return this.parent.lookupType(x);
}
TTypeParameterScope.prototype.lookupTypeParam = function(x) {
	return this.env.get(x) || this.parent.lookupTypeParam(x)
}

// TLocalScope contains non-exported declarations from a module block
function TLocalScope(parent) {
	this.env = new Map
	this.parent = parent;
}
TLocalScope.prototype.lookupType = function(x) {
	return this.env.get(x) || this.parent.lookupType(x)
}
TLocalScope.prototype.lookupTypeParam = function(x) {
	return this.parent.lookupTypeParam(x);
}


var current_scope = null;

// Register the given TLocalScope, so that the merging phase can see it
var local_scopes = []
function registerLocalScope(scope) {
	local_scopes.push(scope)
}

// --------------------
//  Types
// --------------------

function compatibleTypes(x,y) {
	if (x === y)
		return true;
	if (x instanceof TQualifiedReference && y instanceof TQualifiedReference)
		return x.qname === y.qname;
	return false;
}

// Reference to type with the given qualified name
function TQualifiedReference(qname) {
    this.qname = qname; // string
}
TQualifiedReference.prototype.toString = function() {
	return this.qname;
}

// Unresolved reference. Requires name resolution.
function TReference(name, scope) {
    this.name = name; // string
    this.scope = scope; // TScope
}
TReference.prototype.toString = function() {
	return this.name
}

// Type name on form A.B, where A is a type expression and B is an identifier.
function TMember(base, name) {
	this.base = base; // type expression
	this.name = name; // string
}
TMember.prototype.toString = function() {
	return this.base + '.' + this.name
}

// Reference to a type parameter.
function TTypeParam(name) {
    this.name = name;
}
TTypeParam.prototype.toString = function() {
	return this.name
}

// Instantiation of a generic type.
function TGeneric(base, args) {
    this.base = base; // type
    this.args = args; // array of types
}
TGeneric.prototype.toString = function() {
	return this.base + '<' + this.args.join(', ') + '>'
}

// Definition of an enum type (there should only exist one TEnum per enum declaration)
function TEnum(qname) {
	this.qname = qname;
}
TEnum.prototype.toString = function() {
	return this.qname
}

// Object type.
function TObject(qname) {
	this.qname = qname;
    this.properties = new Map;
    this.calls = []
    this.types = new Map;
    this.supers = []
    this.typeParameters = []
}
TObject.prototype.getMember = function(name) {
	var t = this.properties.get(name)
	if (!t) {
	    t = new TObject(null)
	    this.properties.put(name,t)
	}
    return t
}
TObject.prototype.setMember = function(name,typ) {
	var existing = this.properties.get(name)
	if (existing && !compatibleTypes(typ,existing))
		throw new Error("Duplicate identifier " + name);
	this.properties.put(name, typ)
}
TObject.prototype.toString = function() {
	var prtys = []
	this.properties.forEach(function(name,value) {
		prtys.push(name + ': ' + value)
	})
	this.calls.forEach(function(call)  {
		prtys.push('(' + call.parameters.map(function(p){return p.name + ':' + p.type}).join(',') + ') => ' + call.returnType)
	})
	return '{' + prtys.join(', ') + '}'
}

// The any type (only one instance of this)
var TAny = new function TAny() {}
TAny.toString = function() { return 'any' }

// -----------------------------------
//  Extract type environment from AST
// -----------------------------------

function qualify(host, name) {
	if (host === null)
		return null;
	else if (host === '')
		return name;
	else
		return host + '.' + name;
}

// TODO: indexing members
// TODO: optional properties

// Because some types can be extended, we must be careful to distinguish structural types
// from nominal types. For example, parseModule may return a structural type corresponding
// to the body of a module declaration A.B.C, but the final structure of A.B.C may be different.
// Identifiers are resolved relative to the *merged* modules, hence TModuleScope has a qualified name,
// and not a structural type.

// Some names are resolved before merging, others after.
// Type parameters must be resolved before merging, because merging generic interfaces requires
// alpha-renaming of type parameters.
// Names defined in modules must be resolved after merging, because the whole module type is not
// available until then.

function addModuleMember(member, typ) {
	var topLevel = typ.qname === '';
    if (member instanceof TypeScript.FunctionDeclaration) {
    	if (!topLevel && !TypeScript.hasFlag(member.getFunctionFlags(), TypeScript.FunctionFlags.Exported)) {
    		return; // ignore non-exported function
    	}
        typ.setMember(member.name.text(), parseFunctionType(member))
    }
    else if (member instanceof TypeScript.VariableStatement) {
        member.declaration.declarators.members.forEach(function(decl) {
        	if (!topLevel && !TypeScript.hasFlag(decl.getVarFlags(), TypeScript.VariableFlags.Exported)) {
	    		return; // ignore non-exported variable
	    	}
            typ.setMember(decl.id.text(), parseType(decl.typeExpr))
        })
    }
    else if (member instanceof TypeScript.ModuleDeclaration) {
    	var isExported = topLevel || TypeScript.hasFlag(member.getModuleFlags(), TypeScript.ModuleFlags.Exported);
    	var name = member.name.text()
    	if (member.isEnum()) { // enums are ModuleDeclarations in the AST, but they are semantically quite different
    		if (!isExported)
    			return; // ignore non-exported enum
    		var enumObj = parseEnum(member, typ.qname)
    		typ.types.push(name, enumObj.enum)
    		typ.setMember(name, enumObj.object)
    	} else {
    		// TODO: external module (ie. quoted name)
    		if (isExported) {
    			var submodule = parseModule(member, typ.qname)
    			typ.types.push(name, submodule)
    			if (typ.qname !== null) { // if publicly visible
    				typ.setMember(name, new TQualifiedReference(submodule.qname))
    			}
    		} else {
    			var submodule = parseModule(member, null)
    			current_scope.env.push(name, submodule)
    		}
    	}
    }
    else if (member instanceof TypeScript.ClassDeclaration) {
    	if (!topLevel && !TypeScript.hasFlag(member.getVarFlags(), TypeScript.VariableFlags.Exported)) {
    		return; // ignore non-exported class
    	}
        var clazz = parseClass(member, typ.qname)
        typ.setMember(member.name.text(), clazz.constructorType)
        typ.types.push(member.name.text(), clazz.instanceType)
    }
    else if (member instanceof TypeScript.InterfaceDeclaration) {
    	if (!topLevel && !TypeScript.hasFlag(member.getVarFlags(), TypeScript.VariableFlags.Exported)) {
    		return; // ignore non-exported interface
    	}
        var t = parseInterface(member, typ.qname)
        typ.types.push(member.name.text(), t)
    }
    else if (member instanceof TypeScript.ImportDeclaration) {
        var ref = parseType(member.alias)
        if (topLevel || TypeScript.hasFlag(member.getVarFlags(), TypeScript.VariableFlags.Exported)) {
            typ.types.push(member.id.text(), ref)
        } else {
        	// private alias to (potentially) publicly visible type
        	current_scope.env.push(member.id.text(), ref) 
        }
    }
    else if (member instanceof TypeScript.ExportAssignment) {
    	// XXX: I think we can actually just ignore these in the tscheck project,
    	// but for completeness, maybe we should export this information somehow
    	// For reference, this is what I *think* happens:
    	// 		declare module "foo" { export = X }
    	// This means import("foo") will return the value in global variable X.
    	// Maybe we need these for modular analysis?
    }
    else {
    	throw new Error("Unexpected member in module " + typ.qname + ": " + member.constructor.name)
    }
}

function parseModule(node, host) {
	var name = node.name.text()
    var qname = qualify(host, node.name.text()) // todo: quoted names
    var typ = new TObject(qname)
    var namespace = new Map
    current_scope = new TModuleScope(name, current_scope)
    current_scope = new TLocalScope(current_scope)
    registerLocalScope(current_scope)
    node.members.members.forEach(function (member) {
        addModuleMember(member, typ)
    })
    current_scope = current_scope.parent // pop TLocalScope
    current_scope = current_scope.parent // pop TModuleScope
    return typ;
}

function parseEnum(node, host) {
	var qname = qualify(host, node.name.text())
	var enumType = new TEnum(qname)
	var objectType = new TObject(null)
	var selfTypeRef = new TQualifiedReference(qname)
	node.members.members.forEach(function (member) {
		if (member instanceof TypeScript.VariableStatement) {
			member.declaration.declarators.members.forEach(function (decl) {
				objectType.setMember(decl.id.text(), selfTypeRef)
			})
		} else {
			throw new Error("Unexpected enum member: " + member.constructor.name)
		}
	})
	return {
		enum: enumType,
		object: objectType
	}
}

function parseTopLevel(node) {
    var t = new TObject('')
    current_scope = new TTopLevelScope(t)
    node.moduleElements.members.forEach(function (member) {
        addModuleMember(member, t)
    })
    current_scope = null
    return t
}

function parseClass(node, host) {
	var name = node.name.text()
    var qname = qualify(host, name)
    var instanceType = new TObject(qname)
    var constructorType = new TObject(null)
    var instanceRef = new TQualifiedReference(qname)
    
    // put type parameters into scope
    current_scope = new TTypeParameterScope(current_scope)
    var typeParams = []
    node.typeParameters && node.typeParameters.members.forEach(function (tp) {
    	var name = tp.name.text()
    	current_scope.env.put(name, new TTypeParam(name))
    	typeParams.push(parseTypeParameter(tp))
    })
    instanceType.typeParameters = typeParams
    
    // build reference to self type
    var selfTypeArgs = typeParams.map(function(tp) { return new TTypeParam(tp.name) })
    var selfType = selfTypeArgs.length == 0 ? instanceRef : new TGeneric(instanceRef, selfTypeArgs)

    node.extendsList && node.extendsList.members.forEach(function(ext) {
        instanceType.supers.push(parseType(ext))
    })
    node.implementsList && node.implementsList.members.forEach(function(ext) {
        instanceType.supers.push(parseType(ext))
    })
    node.members.members.forEach(function(member) {
        if (member instanceof TypeScript.FunctionDeclaration) {
            if (member.isConstructor) { // syntax: constructor()..
                constructorType.calls.push(parseConstructorFunction(member, selfType, typeParams))
            } else {
                var typ;
                if (member.name)
                    typ = instanceType.getMember(member.name.text())
                else
                    typ = instanceType;
                typ.calls.push(parseFunctionType(member))
            }
        }
        else if (member instanceof TypeScript.VariableDeclarator) {
            instanceType.setMember(member.id.text(), parseType(member.typeExpr))
        }
    })
    current_scope = current_scope.parent // restore previous scope
    return {
        constructorType: constructorType,
        instanceType: instanceType
    }
}
function parseInterface(node, host) {
	var qname = qualify(host, node.name.text());
    var typ = new TObject(qname)
    current_scope = new TTypeParameterScope(current_scope)
    node.typeParameters && node.typeParameters.members.forEach(function(tp,index) {
    	var name = tp.name.text()
    	current_scope.env.put(name, new TTypeParam(name))
        typ.typeParameters.push(parseTypeParameter(tp))
    })
    node.extendsList && node.extendsList.members.forEach(function(ext) {
        typ.supers.push(parseType(ext))
    })
    node.members.members.forEach(function(member) {
        if (member instanceof TypeScript.FunctionDeclaration) {
            var t = member.name ? typ.getMember(member.name.text()) : typ;
            t.calls.push(parseFunctionType(member))
        }
        else if (member instanceof TypeScript.VariableDeclarator) {
            var t = member.typeExpr ? parseType(member.typeExpr) : TAny;
            typ.setMember(member.id.text(), t)
        }
        else {
            throw new Error("Unexpected member " + member.constructor.name + " in interface")
        }
    })
    current_scope = current_scope.parent
    return typ
}

function parseType(node) {
    if (node instanceof TypeScript.GenericType) {
        var t = parseType(node.name)
        var targs = node.typeArguments.members.map(parseType)
        return new TGeneric(t, targs)
    }
    else if (node instanceof TypeScript.TypeReference) {
        var t = parseType(node.term)
        for (var i=0; i<node.arrayCount; i++) {
            t = new TGeneric(new TQualifiedReference('Array'), [t])
        }
        return t;
    }
    else if (node instanceof TypeScript.Identifier) {
    	// try to resolve early (type parameters must be resolved before merging)
    	var t = current_scope.lookupTypeParam(node.text())
    	if (t) {
    		return t;
    	}
    	// defer resolution for later
        return new TReference(node.text(), current_scope)
    }
    else if (node instanceof TypeScript.InterfaceDeclaration) {
        return parseInterface(node)
    } 
    else if (node instanceof TypeScript.FunctionDeclaration) {
        return parseFunctionType(node)
    }
    else if (node instanceof TypeScript.BinaryExpression) {
    	return new TMember(parseType(node.operand1), node.operand2.text())
    }
    else {
        throw new Error("Unexpected type: " + node.constructor.name)
    }
}

function parseParameter(node) {
    return {
        optional: node.isOptional,
        name: node.id.text(),
        type: node.typeExpr ? parseType(node.typeExpr) : TAny
    }
}
    
function parseTypeParameter(node) {
    return {
        name: node.name.text(),
        constraint: node.constraint ? parseType(node.constraint) : null
    }
}

function parseConstructorFunction(node, selfTypeRef, instanceTypeParams) {
    // convert constructor to generic function
    // for example: class Foo<T> { constructor<U>(x:T, y:U) }
    // the constructor type is: <T,U>(x:T, y:U) => Foo<T>
	// reminder: a type parameter and its precedents must be in scope when we parse its constraint
	current_scope = new TTypeParameterScope(current_scope)
	var typeParams = []
	instanceTypeParams.forEach(function(tp,index) {
		current_scope.put(tp.name, new TTypeParam(tp.name))
		typeParams.push(tp)
	})
	node.typeArguments && node.typeArguments.members.forEach(function (tp,index) {
		var name = tp.name.text()
		current_scope.put(name, new TTypeParam(name))
		typeParams.push(parseTypeParameter(tp))
	})
	var t = {
		'new': true,
		variadic: node.variableArgList,
		typeParameters: typeParams,
		parameters: node.arguments.members.map(parseParameter),
        returnType: selfTypeRef
	}
	current_scope = current_scope.parent // restore scope
	return t
}

function parseFunctionType(node) {
	current_scope = new TTypeParameterScope(current_scope)
	var typeParams = []
	node.typeArguments && node.typeArguments.members.forEach(function(tp) {
		var name = tp.name.text()
		current_scope.env.put(name, new TTypeParam(name))
		typeParams.push(parseTypeParameter(tp))
	})
    var result = {
        'new': node.isConstructMember(),
        variadic: node.variableArgList,
        typeParameters: typeParams,
        parameters: node.arguments.members.map(parseParameter),
        returnType: node.returnTypeAnnotation ? parseType(node.returnTypeAnnotation) : TAny
    }
    current_scope = current_scope.parent
    return result
}


// fire up all the machinery above
var global_type = parseTopLevel(ast)



// --------------------
//  Merging types
// --------------------

function mergePropertyInto(typ, other) {
	if (typ instanceof TQualifiedReference && other instanceof TQualifiedReference) {
		if (typ.qname === other.qname) {
			return; // ok
		}
	}
	throw new Error("Incompatible types: " + typ + " and " + other)
}

function renameTypeParametersInParam(param, mapping) {
	return {
		optional: param.optional,
		name: param.name,
		type: renameTypeParametersInType(param.type, mapping)
	}
}

function renameTypeParametersInCall(call, mapping) {
	var typeParams;
	if (call.typeParameters.length > 0) {
		mapping = mapping.clone()
		var invMapping = new Map
		mapping.forEach(function(name,value) {
			invMapping.put(value,name)
		})
		typeParams = call.typeParameters.map(function (tp) {
			// if another thing gets renamed to clash with this, invent a new name for this
			var newName = tp.name
			if (invMapping.has(tp.name)) {
				mapping.put(tp.name, tp.name + '#')
				newName = tp.name + '#'
			} 
			return {
				name: newName,
				constraint: tp.constraint && renameTypeParametersInType(tp.constraint, mapping)
			}
		})
	} else {
		typeParams = []
	}
	return {
		'new': call.new,
		variadic: call.variadic,
		typeParameters: typeParams,
		parameters: call.parameters.map(function(param) {
			return renameTypeParametersInParam(param, mapping)
		}),
		returnType: renameTypeParametersInType(call.returnType, mapping)
	}
}

function renameTypeParametersInType(typ, mapping) {
	if (typ instanceof TTypeParam) {
		var newName = mapping.get(typ.name)
		if (newName)
			return new TTypeParam(newName)
		else
			return typ
	}
	else if (typ instanceof TObject) {
		typ.properties = typ.properties.map(function(name,t) {
			return renameTypeParametersInType(t, mapping)
		})
		typ.calls = typ.calls.map(function(call) {
			return renameTypeParametersInCall(call, mapping)
		})
		return typ
	}
	else if (typ instanceof TGeneric) {
		typ.base = renameTypeParametersInType(typ.base, mapping)
		typ.args = typ.args.map(function(arg) {
			return renameTypeParametersInType(arg, mapping)
		})
		return typ;
	}
	else {
		return typ;
	}
}

function mergeInto(typ, other) {
	console.log("Merging " + typ.qname)
    if (!(typ instanceof TObject) || !(other instanceof TObject)) {
        throw new Error("Incompatible types for " + typ.qname + ": " + typ.constructor.name + " and " + other.constructor.name)
    }
    if (typ === other)
        return;
    if (typ.typeParameters.length !== other.typeParameters.length)
    	throw new Error("Unequal number of type parameters for partial definitions of " + typ.qname)
    var mapping = new Map
    for (var i=0; i<typ.typeParameters.length; i++) {
    	mapping.put(other.typeParameters[i].name, typ.typeParameters[i].name)
    }
    // rename type parameters to the two types agree on their names
    other = renameTypeParametersInType(other, mapping)
    other.properties.forEach(function(name,otherT) {
    	typ.setMember(name, otherT)
    })
    other.types.forEach(function(name,otherT) {
        var typT = typ.types.get(name)
        if (typT) {
            mergeInto(typT, otherT)
        } else if (typT !== otherT) {
            typ.types.put(name, otherT)
        }
    })
}
function mergeObjectTypes(x) {
    if (x instanceof TObject) {
        x.types.forEach(function(name,types) {
            types.forEach(mergeObjectTypes)
            for (var i=1; i<types.length; i++) {
                mergeInto(types[0], types[i])
            }
            x.types.put(name, types[0])
        })
    }
}
function mergeScopeTypes(x) {
	x.env.forEach(function(name,types) {
		types.forEach(mergeObjectTypes)
		for (var i=1; i<types.length; i++) {
			mergeInto(types[0], types[i])
		}
		x.env.put(name, types[0])
	})
}

mergeObjectTypes(global_type)
local_scopes.forEach(mergeScopeTypes)



// ----------------------------------
//  Name resolution
// ----------------------------------

function getCanonicalType(qname) {
	var t = type_env.get(qname)
	if (!t)
		throw new Error("Unresolved type: " + qname)
	return t;
}
function lookupInType(type, name) {
	var obj = resolveToObject(type)
	var t = obj.types.get(name)
	if (!t)
		throw new Error(obj.qname + " does not have a type " + name)
	return t;
}

function lookupCanonicalType(x) {
	if (x instanceof TQualifiedReference)
		return type_env.get(x.qname)
	else if (typeof x === 'string')
		return type_env.get(x)
	else
		throw new Error("Not a qualified name: " + x)
}

function resolveToObject(x) {
	x = resolveType(x)
	if (x instanceof TReference)
		x = x.resolution
	if (x instanceof TObject)
		return x;
	throw new Error("Not an object: " + x);
}

// converts TReference and TMember to TQualifiedReference
function resolveType(x) {
	// TODO: clean this up. resolveType currently acts as identity function, but with side-effects
	if (x instanceof TReference) {
		if (x.resolution)
			return x.resolution
		if (x.resolving)
			throw new Error("Cyclic reference involving " + x)
		x.resolving = true
		// var t = resolveType(lookupInScope(x.scope, x.name))
		var t = x.scope.lookupType(x.name)
		if (!t) {
			t = new TQualifiedReference(x.name) // XXX: for now, assume this is global type
			// throw new Error("Unresolved type: " + x.name)
		}
		t = resolveType(t)
		x.resolution = t;
		return x;
	} else if (x instanceof TMember) {
		if (x.resolution)
			return x.resolution
		if (x.resolving)
			throw new Error("Cyclic reference involving " + x)
		x.resolving = true
		var base = resolveType(x.base)
		var t = resolveType(lookupInType(base, x.name))
		x.resolution = t
		return x;
	} else if (x instanceof TObject) {
		return x;
	} else if (x instanceof TQualifiedReference) {
		return x;
	} else if (x instanceof TTypeParam) {
		return x;
	} else if (x instanceof TGeneric) {
		return x;
	}
	throw new Error("Cannot canonicalize reference to " + (x && x.constructor.name + ': ' + x))
}

function resolveCall(call) {
	return {
		'new': call.new,
		variadic: call.variadic,
		typeParameters: call.typeParameters.map(resolveTypeParameter),
		parameters: call.parameters.map(resolveParameter),
		returnType: resolveType(call.returnType)
	}

}
function resolveTypeParameter(tp) {
	return {
		name: tp.name,
		constraint: tp.constraint && resolveType(tp.constraint)
	}
}

function resolveParameter(param) {
	return {
		optional: param.optional,
		name: param.name,
		type: resolveType(param.type)
	}
}

function resolveObject(type) {
	type.properties.mapUpdate(function(name,typ) {
		return resolveType(typ)
	})
	type.types.mapUpdate(function(name,typ) {
		return resolveType(typ);
	})
	type.supers = type.supers.map(resolveType)
	type.calls = type.calls.map(resolveCall)
	return type;
}

function resolve(x) {
	if (x instanceof TObject) {
		resolveObject(x)
	}
	return x;
}

// type_env.forEach(function(name,type) {
	// resolve(type)
// })
resolveObject(global_type)

TReference.prototype.inspect = function() {
	resolveType(this)
	if (this.resolution.qname)
		return this.resolution.qname;
	return this.name;
}
TMember.prototype.inspect = function() {
	resolveType(this)
	if (this.resolution.qname)
		return this.resolution.qname;
	return this.base + '.' + this.name
}
// console.log(util.inspect(global_type, {depth:null}))

// ----------------------------------
//  Type environment
// ----------------------------------


var type_env = new Map
function buildEnv(type) {
	if (type instanceof TObject) {
		type_env.put(type.qname, type)
		type.types.forEach(function(name,typ) {
			type.types.put(name, buildEnv(typ))
		})
		return new TQualifiedReference(type.qname)	
	}
	else if (type instanceof TEnum) {
		type_env.put(type.qname, type)
		return new TQualifiedReference(type.qname)
	}
	else {
		return type;
	}
}
buildEnv(global_type)

console.log(util.inspect(type_env, {depth:null}))

