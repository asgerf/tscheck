#!/usr/bin/env node
var fs = require('fs');
var tsconvert = require('./tsconvert');
require('sugar');
var Map = require('./map');
var util = require('util');

var program = require('commander');
program.parse(process.argv);

// usage: tscheck SNAPSHOT INTERACE
var snapshotFile = program.args[0]
var snapshotText = fs.readFileSync(snapshotFile, 'utf8');
var snapshot = JSON.parse(snapshotText);

var typeDeclFile = program.args[1];
var typeDeclText = fs.readFileSync(typeDeclFile, 'utf8');
var typeDecl = typeDeclFile.endsWith('.json') ? JSON.parse(typeDeclText) : tsconvert(typeDeclText);


// -----------------------------------
// 		Miscellaneous util stuff
// -----------------------------------

var unique_error_ids = new Map;
function reportUniqueError(uid, msg) {
	if (unique_error_ids.has(uid))
		return;
	unique_error_ids.put(uid, true)
	console.log(msg)
}


function qualify(host, name) {
	return host === '' ? name : (host + '.' + name);
}

function jsonMap(obj,fn) {
	var result = {}
	for (var k in obj) {
		result[k] = fn(obj[k])
	}
	return result
}


// ---------------------------
// 		Lookup functions
// ---------------------------

function lookupObject(key) {
	var obj = snapshot.heap[key];
	if (!obj) {
		throw new Error("Missing object with key " + key)
	}
	return obj;
}

function lookupQType(qname) {
	var t = typeDecl.env[qname];
	if (!t) {
		reportUniqueError('missing:' + qname, "Error: Type " + qname + " is not defined");
	}
	return t;
}


function findPrtyDirect(obj, name) {
	return obj.properties.find(function(x) { return x.name == name });
}
function findPrty(obj, name) {
	while (obj) {
		var prty = findPrtyDirect(obj,name)
		if (prty)
			return prty;
		obj = obj.prototype && lookupObject(obj.prototype.key);
	}
	return null;
}



// ----------------------------------------------
// 		 Type Parameter Substitution
// ----------------------------------------------

function substTypeParameters(tparams, tenv) {
	if (tparams.length === 0)
		return { typeParams: [], tenv: tenv };
	tenv = tenv.clone()
	var typeParams = []
	tparams.forEach(function (tparam) {
		tenv.remove(tparam.name)
		typeParams.push({
			name: tparam.name,
			constraint: tparam.constraint && substType(tparam.constraint, tenv)
		})
	})
	return {
		typeParams: typeParams,
		tenv: tenv
	}
}
function substParameter(param, tenv) {
	return {
		name: param.name,
		optional: param.optional,
		type: substType(param.type, tenv)
	}
}
function substCall(call, tenv) {
	var typeParamSubst = substTypeParameters(call.typeParameters, tenv)
	var typeParams = typeParamSubst.typeParams
	tenv = typeParamSubst.tenv
	return {
		new: call.new,
		variadic: call.variadic,
		typeParameters: typeParams,
		parameters: call.parameters.map(substParameter.fill(undefined, tenv)),
		returnType: substType(call.returnType, tenv)
	}
}
function substPrty(prty, tenv) {
	return {
		optional: prty.optional,
		type: substType(prty.type, tenv)
	}
}
function substType(type, tenv) {
	switch (type.type) {
	case 'type-param':
		var t = tenv.get(type.name);
		if (t)
			return t;
		else
			return type; // this can happen when type params are shadowed by function type params (I think)
	case 'object':
		return {
			type: 'object',
			typeParameters: [],
			properties: jsonMap(type.properties, substPrty.fill(undefined,tenv)),
			calls: type.calls.map(substCall.fill(undefined,tenv)),
			supers: type.supers.map(substType.fill(undefined,tenv)),
			stringIndexer: type.stringIndexer && substType(type.stringIndexer, tenv),
			numberIndexer: type.numberIndexer && substType(type.numberIndexer, tenv)
		}
		break;
	case 'generic':
		return {
			type: 'generic',
			base: substType(type.base, tenv),
			args: type.args.map(substType.fill(undefined,tenv))
		}
	default:
		return type;
	}
}


// ---------------------------------
// 		 Type Canonicalization
// ---------------------------------

var canonical_cache = {}
var canonical_next_number = 1;
function canonicalizeKey(key) {
	var value = canonical_cache[key]
	if (!value) {
		value = canonical_next_number++
		canonical_cache[key] = value
	}
	return value
}
function escapeStringConst(str) {
	return str; // todo, but only necessary in unrealistic circumstances
}
function canonicalizeCall(call) {
	var buf = []
	buf.push('<')
	call.typeParameters.forEach(function(tp) {
		buf.push(tp.name)
		buf.push(',')
	})
	buf.push('>(')
	call.parameters.forEach(function(param) {
		buf.push(param.optional ? '?' : '')
		buf.push(canonicalizeType(param.type))
		buf.push(';')
	})
	buf.push(')')
	buf.push(canonicalizeType(call.returnType))
	var key = buf.join('')
	return canonicalizeKey(key)
}
function canonicalizeType(type) {
	switch (type.type) {
		case 'object':
			if (type.canonical_id)
				return type.canonical_id;
			var bag = []
			for (k in type.properties) {
				var prty = type.properties[k]
				bag.push(k + (prty.optional ? '?' : '') + ':' + canonicalizeType(prty.type))
			}
			type.calls.forEach(function(call) {
				bag.push('#' + canonicalizeCall(call))
			})
			type.supers.forEach(function(sup) {
				bag.push('<:' + canonicalizeType(sup))
			})
			if (type.stringIndexer)
				bag.push('[S]:' + canonicalizeType(type.stringIndexer))
			if (type.numberIndexer)
				bag.push('[N]:' + canonicalizeType(type.numberIndexer))
			var key = bag.sort().join(';')
			var id = canonicalizeKey(key);
			type.canonical_id = id;
			return id;
		case 'generic':
			var key = canonicalizeType(type.base) + '<' + type.args.map(canonicalizeType).join(';') + '>'
			return canonicalizeKey(key)
		case 'number':
			return 'N';
		case 'boolean':
			return 'B';
		case 'string':
			return 'S';
		case 'string-const':
			return 'C:' + escapeStringConst(type.value)
		case 'any':
			return 'A';
		case 'void':
			return 'V';
		case 'reference':
			return '@' + type.name;
		default:
			throw new Error("Unrecognized type: " + util.inspect(type))
	}
}

// ------------------------------------------------------------
// 		 Recursive check of Value vs Type
// ------------------------------------------------------------

var assumptions = {}
function check(type, value, path) {
	function reportError(msg) {
		console.log((path || '<global>') + ": " + msg)
	}
	function must(condition) {
		if (!condition) {
			reportError("expected " + formatType(type) + " but found value " + formatValue(value));
			return false;
		} else {
			return true;
		}
	}
	if (!type) {
		throw new Error("Undefined type on path: " + path)
	}
	if (type.type === 'reference') {
		if (value.key) {
			var assumKey = value.key + '~' + canonicalizeType(type);
			if (assumptions[assumKey])
				return; // we are assuming this typing holds
			assumptions[assumKey] = true
		}
		type = lookupQType(type.name);
		if (!type)
			return; // an error was already issued, just assume check passed
	}
	switch (type.type) {
		case 'object':
			if (must(typeof value === 'object')) {
				// todo: also check supers
				var obj = lookupObject(value.key)
				for (var k in type.properties) {
					var typePrty = type.properties[k]
					var objPrty = findPrty(obj, k)
					if (!objPrty) {
						if (!typePrty.optional) {
							reportError("missing property " + k)
						}
					} else {
						if (objPrty.value) {
							check(typePrty.type, objPrty.value, qualify(path,k))
						} else {
							// todo: getters and setters require static analysis
						}
					}
				}
			}
			break;
		case 'type-param':
			// should be replaced by substType before we get here
			throw new Error("Checking value " + formatValue(value) + " against unbound type parameter " + type.name);
		case 'generic':
			if (type.base.type !== 'reference')
				throw new Error("Base type of generic must be a reference"); // TODO: update spec to enforce this
			if (value === null)
				return; // null matches any object type
			if (!must(typeof value === 'object'))
				return; // only objects can match generic
			var assumKey = value.key + '~' + canonicalizeType(type)
			if (assumptions[assumKey])
				return; // already checked or currently checking
			assumptions[assumKey] = true
			var objectType = lookupQType(type.base.name)
			if (!objectType) {
				return; // error was issued elsewhere
			}
			if (objectType.typeParameters.length !== type.args.length) {
				reportError("expected " + objectType.typeParameters.length + " type parameters but got " + type.args.length);
				return;
			}
			var tenv = new Map
			for (var i=0; i<objectType.typeParameters.length; i++) {
				tenv.put(objectType.typeParameters[i].name, type.args[i])
			}
			var instantiatedType = substType(objectType, tenv)
			check(instantiatedType, value, path) // just check against raw type (anything matches 'type-param' at the moment)
			break;
		case 'enum':
			must(typeof value === 'number')
			break;
		case 'string-const':
			must(typeof value === 'string' && value === type.value)
			break;
		case 'number':
			must(typeof value === 'number');
			break;
		case 'string':
			must(typeof value === 'string'); // todo: instances of String
			break;
		case 'boolean':
			must(typeof value === 'boolean');
			break;
		case 'any':
			break; // no check necessary
		case 'void':
			break; // ?
		default:
			throw new Error("Unrecognized type type: " + type.type + " " + util.inspect(type))
	}
}

check(lookupQType(typeDecl.global), {key: snapshot.global}, '');


// ------------------------------------------
// 		Formatting types and values
// ------------------------------------------

function formatTypeProperty(name,prty) {
	return name + (prty.optional ? '?' : '') + ': ' + formatType(prty.type)
}
function formatTypeCall(call) {
	return '(' + call.parameters.map(formatParameter).join(', ') + ') => ' + formatType(call.returnType)
}
function formatParameter(param) {
	return param.name + (param.optional ? '?' : '') + ':' + param.type
}

function formatType(type) {
	switch (type.type) {
		case 'reference':
			return type.name;
		case 'object':
			var members = []
			for (var k in type.properties) {
				var prty = type.properties[k];
				members.push(k + (prty.optional ? '?' : '') + ': ' + formatType(prty.type))
			}
			members = members.concat(type.calls.map(formatTypeCall).join(', '));
			return '{' + members.join(', ') + '}'
		case 'string':
			return 'string';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'void':
			return 'void';
		case 'any':
			return 'any';
	}
	return util.inspect(type)
}
function formatValue(value, depth) {
	if (typeof depth === 'undefined')
		depth = 1;
	if (typeof value === 'object' && value !== null) {
		if (depth <= 0)
			return value.function ? '[Function]' : '[Object]'
		var fn = value.function ? 'Function ' : ''
		return fn + '{ ' + lookupObject(value.key).properties.map(function(prty) { return prty.name + ': ' + formatValue(prty.value,depth-1) }).join(', ') + ' }'
	} else {
		return util.inspect(value)
	}
}


