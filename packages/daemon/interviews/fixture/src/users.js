const users = new Map();
let nextId = 1;

export function createUser({ name, email }) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');
  if (name.length > 50) throw new Error('name is too long');
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email))
    throw new Error('email is invalid');
  const user = { id: nextId++, name: name.trim(), email: email.toLowerCase() };
  users.set(user.id, user);
  return user;
}

export function updateUser(id, { name, email }) {
  const user = users.get(id);
  if (!user) throw new Error('user not found');
  if (typeof name !== 'string' || name.trim() === '') throw new Error('name is required');
  if (name.length > 50) throw new Error('name is too long');
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email))
    throw new Error('email is invalid');
  user.name = name.trim();
  user.email = email.toLowerCase();
  return user;
}
