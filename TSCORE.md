TSCore
======

**TSCore** is a subsystem in tscheck which converts a `.d.ts` file into an instance of a much simpler structural type system, in which name resolution and inheritance have been fully resolved.

TSCore is of no importance to most TypeScript users, but programming language enthusiasts working with TypeScript may find it useful.

The output of tscore is a JSON-like object following this informal specification:

```
type TypeScriptDeclarationFile = {
	global: string 	// name of global type in env
	env: StringMap[TypeDef]
	externs: StringMap[string] // external module names -> key in TypeEnv,
	enums: StringMap[EnumDef]
}

interace StringMap[T] = { // map from string to T
	[s:string]: T 	
}

// paths to values of enum, (eg. [Foo.X, Foo.Y, Foo.Z])
type EnumDef = Array[String] 

interface TypeDef {
	typeParameters: Array[string],
	object: ObjectType
}

type Type
	= ObjectType 
	| EnumType 
	| BuiltinType 
	| StringConstType 
	| TypeParamRef 
	| TypeRef

interface TypeRef {
	type: 'reference',
	name: string 	// index into type env
	typeArguments: Array[Type]
}
interface ObjectType {
	type: 'object'
	properties: StringMap[Property]
	calls: Array[Call]
	stringIndexer: Type | null
	numberIndexer: Type | null
	brand: string | null // path to constructor
	meta: {
		kind: 'module' | 'class' | 'interface'
		origin: string 			// which file contributed the type
	}
}
interface Property {
	optional: boolean
	type: Type
	meta: {
		origin: string  	     // which file contributed the property
	}
}
interface Call {
	new: boolean
	variadic: boolean
	typeParameters: Array[TypeParameter]
	parameters: Array[Parameter]
	returnType: Type
	meta: {
		implicit: boolean 	// true if default constructor
	}
}
}
interface Parameter {
	optional: boolean
	name: string
	type: Type
}
interface TypeParameter {
	name: string
	constraint: Type | null
}
interface EnumType {
	type: 'enum'
	name: string
}
interface BuiltinType {
	type: 'number' | 'string' | 'boolean' | 'void' | 'any'
}
interface StringConstType {
	type: 'string-const'
	value: string
}
interface TypeParamRef {
	type: 'type-param'
	name: string
}
```