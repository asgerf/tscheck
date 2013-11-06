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
function TModuleScope(qname, parent) {
    this.qname = qname;
    this.parent = parent;
}
function TFixedScope(parent) {
    this.env = new Map
    this.parent = parent;
}

var current_scope = new TModuleScope('', null)

// --------------------
//  Types
// --------------------

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

// Object type.
function TObject(qname) {
	this.qname = qname;
    this.properties = new Map;
    this.calls = []
    this.types = new Map;
    this.supers = []
    this.typeParameters = []
}
TObject.prototype.makeMember = function(name) {
    var t = new TObject(null)
    this.properties.push(name,t)
    return t
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

// Because some types can be extended, we must be careful to distinguish structural types
// from nominal types. For example, parseModule may return a structural type corresponding
// to the body of a module declaration A.B.C, but the final structure of A.B.C may be different.
// Identifiers are resolved relative to the *merged* modules, hence TModuleScope has a qualified name,
// and not a structural type.

function addModuleMember(member, typ) {
	var prefix = typ.qname === '' ? '' : (typ.qname + '.');
    if (member instanceof TypeScript.FunctionDeclaration) {
        typ.properties.push(member.name.text(), parseFunctionType(member))
    }
    else if (member instanceof TypeScript.VariableStatement) {
        member.declaration.declarators.members.forEach(function(decl) {
            typ.properties.push(decl.id.text(), parseType(decl.typeExpr))
        })
    }
    else if (member instanceof TypeScript.ModuleDeclaration) {
        var submodule = parseModule(member, prefix)
        typ.types.push(member.name.text(), submodule)
        typ.properties.push(member.name.text(), new TQualifiedReference(submodule.qname))
    }
    else if (member instanceof TypeScript.ClassDeclaration) {
        var clazz = parseClass(member, prefix)
        typ.properties.push(member.name.text(), clazz.constructorType)
        typ.types.push(member.name.text(), clazz.instanceType)
    }
    else if (member instanceof TypeScript.InterfaceDeclaration) {
        var t = parseInterface(member, prefix)
        typ.types.push(member.name.text(), t)
    }
    else if (member instanceof TypeScript.ImportDeclaration) {
        var ref = parseType(member.alias)
        typ.types.push(member.id.text(), ref)
        if (TypeScript.hasFlag(member.getVarFlags(), TypeScript.VariableFlags.Exported)) {
            typ.properties.push(member.id.text(), ref) // aliasing ok here, ref can only be reference
        }
    }
    else {
    	throw new Error("Unexpected member in module " + typ.qname + ": " + member.constructor.name)
    }
}

function parseModule(node, prefix) {
    var qname = prefix + node.name.text() // todo: quoted names
    var typ = new TObject(qname)
    var namespace = new Map
    current_scope = new TModuleScope(qname, current_scope)
    node.members.members.forEach(function (member) {
        addModuleMember(member, typ)
    })
    current_scope = current_scope.parent // restore previous scope
    return typ;
}

function parseTopLevel(node) {
    var t = new TObject('')
    node.moduleElements.members.forEach(function (member) {
        addModuleMember(member, t)
    })
    return t
}

function parseClass(node, prefix) {
    var qname = prefix + node.name.text()
    var instanceType = new TObject(qname)
    var constructorType = new TObject(null)
    var instanceRef = new TQualifiedReference(qname)
    
    // put type parameters into scope
    current_scope = new TFixedScope(current_scope)
    var typeParams = node.typeParameters ? node.typeParameters.members.map(parseTypeParameter) : []
    typeParams.forEach(function (tp) {
        instanceType.typeParameters.push(tp)
        current_scope.env.put(tp.name, new TTypeParam(tp.name))
    })
    
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
                var fun = parseFunctionType(member)
                // convert constructor to generic function
                // for example: class Foo<T> { constructor<U>(x:T, y:U) }
                // the constructor type is: <T,U>(x:T, y:U) => Foo<T>
                fun.typeParameters = typeParams.concat(fun.typeParameters)
                fun.returnType = selfType
                fun.new = true
                constructorType.calls.push(fun)
            } else {
                var typ;
                if (member.name)
                    typ = instanceType.makeMember(member.name.text())
                else
                    typ = instanceType;
//                var typ = member.name ? instanceType.getMember(member.name.text()) : instanceType;
                typ.calls.push(parseFunctionType(member))
            }
        }
        else if (member instanceof TypeScript.VariableDeclarator) {
            instanceType.properties.push(member.id.text(), parseType(member.typeExpr))
        }
    })
    current_scope = current_scope.parent // restore previous scope
    return {
        constructorType: constructorType,
        instanceType: instanceType
    }
}
function parseInterface(node, prefix) {
	var qname = typeof prefix === 'string' ? prefix + node.name.text() : null;
    var typ = new TObject(qname)
    node.typeParameters && node.typeParameters.members.forEach(function(tp) {
        typ.typeParameters.push(tp.name.text())
    })
    node.extendsList && node.extendsList.members.forEach(function(ext) {
        typ.supers.push(parseType(ext))
    })
    node.members.members.forEach(function(member) {
        if (member instanceof TypeScript.FunctionDeclaration) {
            var t = member.name ? typ.makeMember(member.name.text()) : typ;
            t.calls.push(parseFunctionType(member))
        }
        else if (member instanceof TypeScript.VariableDeclarator) {
            var t = member.typeExpr ? parseType(member.typeExpr) : TAny;
            typ.properties.push(member.id.text(), t)
        }
        else {
            throw new Error("Unexpected member " + member.constructor.name + " in interface")
        }
    })
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

function parseFunctionType(node) {
    return {
        'new': node.isConstructMember(),
        variadic: node.variableArgList,
        typeParameters: node.typeArguments ? node.typeArguments.members.map(parseTypeParameter) : [],
        parameters: node.arguments.members.map(parseParameter),
        returnType: node.returnTypeAnnotation ? parseType(node.returnTypeAnnotation) : TAny
    }
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

function mergeInto(typ, other) {
    if (!(typ instanceof TObject) || !(other instanceof TObject)) {
        throw new Error("Incompatible types for " + typ.qname + ": " + typ.constructor.name + " and " + other.constructor.name)
    }
    if (typ === other)
        return;
    other.properties.forEach(function(name,otherT) {
        var typT = typ.properties.get(name)
        if (typT) {
            mergeInto(typT, otherT)
        } else if (typT !== otherT) {
            typ.properties.put(name, otherT)
        }
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
function mergeContents(x) {
    if (x instanceof TObject) {
        x.properties.forEach(function(name,types) {
            for (var i=1; i<types.length; i++) {
                mergeInto(types[0], types[i])
            }
            x.properties.put(name, types[0])
        })
        x.types.forEach(function(name,types) {
            types.forEach(mergeContents)
            for (var i=1; i<types.length; i++) {
                mergeInto(types[0], types[i])
            }
            x.types.put(name, types[0])
        })
    }
}

mergeContents(global_type)

// ----------------------------------
//  Type environment
// ----------------------------------

var type_env = new Map
function buildEnv(type) {
	if (!(type instanceof TObject))
		return type
	type_env.put(type.qname, type)
	type.types.forEach(function(name,typ) {
		type.types.put(name, buildEnv(typ))
	})
	return new TQualifiedReference(type.qname)
}
buildEnv(global_type)

// ----------------------------------
//  Name resolution
// ----------------------------------

function lookupInScopeDirect(scope, name) {
	if (scope instanceof TModuleScope) {
		var module = type_env.get(scope.qname)
		if (!module)
			throw new Error("Cannot find module " + scope.qname)
		return module.types.get(name)
	}
	else if (scope instanceof TFixedScope) {
		return scope.env.get(name)
	}
	else {
		throw new Error("Unrecognized scope: " + scope)
	}
}
function lookupInScope(scope, name) {
	while (scope !== null) {
		var t = lookupInScopeDirect(scope,name)
		if (t)
			return t;
		scope = scope.parent
	}
	// XXX: for now, assume name is global
	return new TQualifiedReference(name)
	// throw new Error("Unresolved name: " + name)
}
function lookupInType(type, name) {
	if (type instanceof TQualifiedReference)
		type = type_env.get(type.qname)
	if (type instanceof TObject) {
		var t = type.types.get(name)
		if (!t)
			throw new Error(type.qname + " does not have a type " + name)
		return t;
	} else {
		throw new Error(name + " is not an object type")
	}
}

function lookupCanonicalType(x) {
	if (x instanceof TQualifiedReference)
		return type_env.get(x.qname)
	else if (typeof x === 'string')
		return type_env.get(x)
	else
		throw new Error("Not a qualified name: " + x)
}

// converts TReference and TMember to TQualifiedReference
function resolveType(x) {
	if (x instanceof TReference) {
		if (x.resolution)
			return x.resolution
		if (x.resolving)
			throw new Error("Cyclic reference involving " + x)
		x.resolving = true
		var t = resolveType(lookupInScope(x.scope, x.name))
		x.resolution = t;
		return t;
	} else if (x instanceof TMember) {
		if (x.resolution)
			return x.resolution
		if (x.resolving)
			throw new Error("Cyclic reference involving " + x)
		x.resolving = true
		var base = resolveType(x.base)
		var t = resolveType(lookupInType(base, x.name))
		x.resolution = t
		return t;
	} else if (x instanceof TObject) {
		if (x.qname)
			return new TQualifiedReference(x.qname)
		else
			return resolveObject(x)
	} else if (x instanceof TQualifiedReference) {
		return x;
	}
	throw new Error("Cannot canonicalize reference to type: " + x.constructor.name)
}

function resolveCall(call) {

}
function canonicalizeTypeParameter(tp) {

}

function resolveObject(type) {
	type.properties.mapUpdate(function(name,typ) {
		return resolveType(typ)
	})
	type.types.mapUpdate(function(name,typ) {
		return resolveType(typ)
	})
	type.supers = type.supers.map(resolveType)
	type.calls.forEach(resolveCall)
	return type;
}

function resolve(x) {
	if (x instanceof TObject) {
		resolveObject(x)
		return x;
	} else if (x instanceof TReference) {
		return resolveType(x)
	}
	return x;
}

type_env.forEach(function(name,type) {
	resolveObject(type)
})
resolveObject(global_type)

console.log(util.inspect(type_env, {depth:null}))


