# CodeStats-Core — Prompts

Copia y pega cualquiera de estos prompts en tu IA (Claude, ChatGPT, Gemini, etc.) seguido de tu petición. El código generado será compatible con el panel CodeStats-Core de VS Code.

---

## 1. GENERAR código nuevo

```
Genera código en formato CodeStats-Core.

REGLAS OBLIGATORIAS:
1. Incluye un bloque meta al inicio usando comentarios del lenguaje:

Para Python:
# ---meta
# name: NombreDelComponente
# type: service|controller|model|util|repository
# desc: Qué hace este componente en 1-2 oraciones claras
# in: [tipo param1, tipo param2]
# out: TipoRetorno | TipoError
# deps: [dep1, dep2]
# methods: [metodo1(firma), metodo2(firma)]
# errors: [Error1, Error2]
# ---

Para JS/TS:
// ---meta
// name: NombreDelComponente
// type: service|controller|model|util|repository
// desc: Qué hace este componente en 1-2 oraciones claras
// in: [tipo param1, tipo param2]
// out: TipoRetorno | TipoError
// deps: [dep1, dep2]
// methods: [metodo1(firma), metodo2(firma)]
// errors: [Error1, Error2]
// ---

Para PHP:
// ---meta
// name: NombreDelComponente
// type: service|controller|model|util|repository
// desc: Qué hace este componente en 1-2 oraciones claras
// in: [tipo param1, tipo param2]
// out: TipoRetorno | TipoError
// deps: [dep1, dep2]
// methods: [metodo1(firma), metodo2(firma)]
// errors: [Error1, Error2]
// ---

2. Código compacto y funcional
3. Tipado estricto en TODOS los parámetros y retornos
4. Manejo de errores con excepciones tipadas
5. Máximo 5 parámetros por función (si necesitas más, usa un objeto/dataclass)
6. Máximo 30 líneas por método
7. NO incluyas: comentarios decorativos, docstrings extensos, emojis, separadores, print de debug
8. NO incluyas: valores hardcoded (URLs, credenciales, puertos). Usa variables de entorno o parámetros
9. SÍ incluye: type hints, nombres descriptivos, manejo de errores, constantes con nombre
10. Declara en meta.deps TODAS las dependencias externas que uses

Mi petición:
```

---

## 2. CONVERTIR código existente

```
Convierte el siguiente código al formato CodeStats-Core.

INSTRUCCIONES:
1. Analiza el código y genera un bloque meta al inicio (usa el estilo de comentario del lenguaje)
2. El bloque meta debe tener:
   - name: nombre principal del componente
   - type: service|controller|model|util|repository (infiere el tipo)
   - desc: qué hace en 1-2 oraciones
   - in: parámetros de entrada principales
   - out: tipos de retorno principales
   - deps: TODAS las dependencias/imports externos
   - methods: lista de métodos públicos con firma
   - errors: excepciones que lanza o maneja

3. Después del bloque meta, incluye el código ORIGINAL sin modificar
4. Si el código tiene problemas de tipado, agrégale type hints
5. Si hay valores hardcoded (URLs, passwords, API keys), muévelos a constantes o parámetros
6. Si hay TODO/FIXME, déjalos pero asegúrate de que sean visibles
7. NO cambies la lógica, NO borres código funcional

CÓDIGO A CONVERTIR:
```

---

## 3. CONVERTIR y COMPACTAR

```
Convierte y compacta el siguiente código al formato CodeStats-Core.

INSTRUCCIONES:
1. Genera el bloque meta completo (name, type, desc, in, out, deps, methods, errors)
2. Reescribe el código optimizado:
   - Elimina comentarios decorativos y docstrings vacíos
   - Elimina líneas en blanco innecesarias
   - Mantén tipado estricto
   - Mantén manejo de errores
   - Mueve hardcoded values a constantes/config
   - NO cambies la lógica ni el comportamiento
   - NO superes 30 líneas por método
   - NO superes 5 parámetros por función

3. El objetivo: menos tokens, misma funcionalidad, más verificable

CÓDIGO A CONVERTIR:
```

---

## 4. CORREGIR un error

Cuando CodeStats-Core te muestre un error, haz click para copiarlo y usa este prompt:

```
Corrige el siguiente error en mi código.

ERROR:
[pega aquí el error copiado de CodeStats-Core]

CÓDIGO ACTUAL:
[pega tu código aquí]

INSTRUCCIONES:
- Corrige SOLO el error indicado
- Mantén el bloque ---meta actualizado si cambias firma/deps
- Mantén el formato CodeStats-Core
- Explica brevemente qué causaba el error
```

---

## 5. MEJORAR un método específico

Cuando uses "Extraer prompt de método" en CodeStats-Core, se genera automáticamente. Pero si quieres hacerlo manual:

```
Mejora el siguiente método manteniendo la misma firma y comportamiento.

CONTEXTO:
- Lenguaje: [python/typescript/php]
- Clase: [NombreClase]
- Método: [nombre(params) → ReturnType]

CÓDIGO ACTUAL:
[pega el método aquí]

INSTRUCCIONES:
- Mejora legibilidad y mantenibilidad
- Agrega type hints donde falten
- Mejora manejo de errores
- Reduce complejidad si es posible
- NO cambies la firma pública
- Devuelve SOLO el método mejorado en formato CodeStats-Core
```

---

## Ejemplos de salida esperada

### Python
```python
# ---meta
# name: AuthService
# type: service
# desc: Autenticación JWT. Valida credenciales y genera tokens con expiración configurable.
# in: [str email, str password]
# out: Session | AuthError
# deps: [bcrypt, jwt, datetime]
# methods: [authenticate(email,password), refresh_token(token), revoke(session_id)]
# errors: [AuthError, TokenExpiredError, InvalidCredentialsError]
# ---

from datetime import datetime, timedelta
from typing import Optional
import bcrypt, jwt

class AuthError(Exception): pass
class TokenExpiredError(AuthError): pass
class InvalidCredentialsError(AuthError): pass

class Session:
    def __init__(self, user_id: str, token: str, expires: datetime):
        self.user_id = user_id
        self.token = token
        self.expires = expires

class AuthService:
    def __init__(self, repo, secret: str, ttl: int = 3600):
        self.repo = repo
        self.secret = secret
        self.ttl = ttl

    async def authenticate(self, email: str, password: str) -> Session:
        user = await self.repo.find_by_email(email)
        if not user or not bcrypt.checkpw(password.encode(), user.hash):
            raise InvalidCredentialsError()
        exp = datetime.utcnow() + timedelta(seconds=self.ttl)
        token = jwt.encode({"sub": user.id, "exp": exp}, self.secret)
        return Session(user.id, token, exp)

    async def refresh_token(self, token: str) -> Session:
        try:
            data = jwt.decode(token, self.secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            raise TokenExpiredError()
        exp = datetime.utcnow() + timedelta(seconds=self.ttl)
        new_token = jwt.encode({"sub": data["sub"], "exp": exp}, self.secret)
        return Session(data["sub"], new_token, exp)

    async def revoke(self, session_id: str) -> bool:
        return await self.repo.delete_session(session_id)
```

### TypeScript
```typescript
// ---meta
// name: UserController
// type: controller
// desc: Endpoints REST para gestión de usuarios. CRUD completo con validación.
// in: [Request, Response]
// out: JsonResponse | HttpError
// deps: [express, UserService]
// methods: [getAll(req,res), getById(req,res), create(req,res), delete(req,res)]
// errors: [NotFoundError, ValidationError]
// ---

import { Request, Response } from 'express';
import { UserService } from './UserService';

class NotFoundError extends Error {
  constructor(id: string) { super(`User ${id} not found`); }
}
class ValidationError extends Error {}

export class UserController {
  constructor(private service: UserService) {}

  async getAll(_req: Request, res: Response): Promise<void> {
    const users = await this.service.findAll();
    res.json(users);
  }

  async getById(req: Request, res: Response): Promise<void> {
    const user = await this.service.findById(req.params.id);
    if (!user) throw new NotFoundError(req.params.id);
    res.json(user);
  }

  async create(req: Request, res: Response): Promise<void> {
    const { email, name } = req.body;
    if (!email || !name) throw new ValidationError('email and name required');
    const user = await this.service.create({ email, name });
    res.status(201).json(user);
  }

  async delete(req: Request, res: Response): Promise<void> {
    await this.service.delete(req.params.id);
    res.status(204).send();
  }
}
```

### PHP
```php
<?php
// ---meta
// name: ProductRepository
// type: repository
// desc: Acceso a datos de productos. Queries optimizadas con cache opcional.
// in: [int id, array filters]
// out: Product | null
// deps: [PDO, Redis]
// methods: [find(id), findAll(filters), save(product), delete(id)]
// errors: [NotFoundException, DatabaseException]
// ---

use App\Models\Product;

class NotFoundException extends \RuntimeException {}
class DatabaseException extends \RuntimeException {}

class ProductRepository
{
    public function __construct(
        private \PDO $db,
        private ?\Redis $cache = null
    ) {}

    public function find(int $id): Product
    {
        if ($this->cache) {
            $cached = $this->cache->get("product:{$id}");
            if ($cached) return unserialize($cached);
        }
        $stmt = $this->db->prepare('SELECT * FROM products WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) throw new NotFoundException("Product {$id}");
        return new Product($row);
    }

    public function findAll(array $filters = []): array
    {
        $sql = 'SELECT * FROM products WHERE 1=1';
        $params = [];
        if (isset($filters['category'])) {
            $sql .= ' AND category = ?';
            $params[] = $filters['category'];
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return array_map(fn($r) => new Product($r), $stmt->fetchAll());
    }

    public function save(Product $product): Product
    {
        $stmt = $this->db->prepare('INSERT INTO products (name, price, category) VALUES (?, ?, ?)');
        $stmt->execute([$product->name, $product->price, $product->category]);
        $product->id = (int) $this->db->lastInsertId();
        $this->cache?->del("product:{$product->id}");
        return $product;
    }

    public function delete(int $id): void
    {
        $stmt = $this->db->prepare('DELETE FROM products WHERE id = ?');
        $stmt->execute([$id]);
        if ($stmt->rowCount() === 0) throw new NotFoundException("Product {$id}");
        $this->cache?->del("product:{$id}");
    }
}
```
