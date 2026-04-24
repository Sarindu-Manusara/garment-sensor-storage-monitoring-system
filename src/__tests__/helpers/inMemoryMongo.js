class InMemoryCursor {
  constructor(documents) {
    this.documents = documents.slice();
  }

  sort(sortSpec) {
    const entries = Object.entries(sortSpec);
    this.documents.sort((left, right) => {
      for (const [field, direction] of entries) {
        const leftValue = left[field];
        const rightValue = right[field];
        if (leftValue < rightValue) {
          return -1 * direction;
        }
        if (leftValue > rightValue) {
          return 1 * direction;
        }
      }
      return 0;
    });
    return this;
  }

  limit(limit) {
    this.documents = this.documents.slice(0, limit);
    return this;
  }

  async next() {
    return this.documents[0] || null;
  }

  async toArray() {
    return this.documents.slice();
  }
}

function matchesOperator(documentValue, operatorValue) {
  if (operatorValue.$gte !== undefined && documentValue < operatorValue.$gte) {
    return false;
  }
  if (operatorValue.$lte !== undefined && documentValue > operatorValue.$lte) {
    return false;
  }
  if (operatorValue.$ne !== undefined && documentValue === operatorValue.$ne) {
    return false;
  }
  if (operatorValue.$exists !== undefined) {
    const exists = documentValue !== undefined;
    if (Boolean(operatorValue.$exists) !== exists) {
      return false;
    }
  }

  return true;
}

class InMemoryCollection {
  constructor(documents = []) {
    this.documents = documents.slice();
  }

  createIndex() {
    return Promise.resolve();
  }

  find(query = {}) {
    const filtered = this.documents.filter((document) => {
      for (const [field, value] of Object.entries(query)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (!matchesOperator(document[field], value)) {
            return false;
          }
          continue;
        }

        if (document[field] !== value) {
          return false;
        }
      }
      return true;
    });

    return new InMemoryCursor(filtered);
  }

  async insertOne(document) {
    const stored = {
      _id: String(this.documents.length + 1),
      ...document
    };
    this.documents.push(stored);
    return { insertedId: stored._id };
  }

  async deleteMany(query = {}) {
    const before = this.documents.length;
    this.documents = this.documents.filter((document) => {
      for (const [field, value] of Object.entries(query)) {
        if (document[field] !== value) {
          return true;
        }
      }
      return false;
    });

    return {
      deletedCount: before - this.documents.length
    };
  }
}

module.exports = {
  InMemoryCollection
};
