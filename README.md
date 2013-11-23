tscheck
=======

Analysis tool for TypeScript interfaces.


Normalized Type Format
======================

tscheck converts a TypeScript declaration file (`*.d.ts`) into a type environment in the following format:

```
type TypeScriptDeclarationFile = {
	global: string 	// name of global type in env
	env: StringMap[TypeDef]
	externs: StringMap[string] // external module names -> key in TypeEnv
}

interace StringMap[T] = { // map from string to T
	[s:string]: T 	
}

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
}
interface Property {
	origin: string  // which file contributed the property
	optional: boolean
	type: Type
}
interface Call {
	new: boolean
	variadic: boolean
	typeParameters: Array[TypeParameter]
	parameters: Array[Parameter]
	returnType: Type
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
